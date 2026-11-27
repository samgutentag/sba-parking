# SBA Parking

Tracks how many spaces are open in Santa Barbara Airport's three public lots, stores every change the airport's feed publishes, and serves a small page that shows current availability, a chart of open spots over time, and the airport's own flight board tracked alongside it.

Zero runtime dependencies. Node 24 covers everything: `fetch`, `node:sqlite`, `node:http`, and native TypeScript type stripping. The only dev dependencies are `typescript` and `@types/node`, used for `pnpm typecheck`.

## Run

```sh
pnpm install          # dev deps only
pnpm start            # both pollers + web page on http://127.0.0.1:3210
pnpm dev              # same, restarts on file change
pnpm poll             # one parking poll, then exit (for cron)
pnpm poll:flights     # one flights poll, then exit (for cron)
pnpm typecheck
```

Configuration is by environment variable. See `.env.example`. Set `USER_AGENT` to include a contact address before running this anywhere for long: the upstream is a `.gov` Drupal site and the route is undocumented.

## Data source

`GET https://flysba.santabarbaraca.gov/citizen-parking-data/latest`

No auth, no key. Returns one object per lot:

```json
{"lot_id":"3","lot_name":"Short-term Parking","total_spaces":"192","occupied_spaces":"168","updated":"08/13/2026 - 14:03"}
```

Things the code assumes, all lifted from the original research:

- Three lots today: `2` Economy, `3` Short-term, `4` Long-term. Totals are stored per reading, not hardcoded, because they can change.
- Every value is a string. Everything is cast and validated in `src/source.ts`.
- `updated` is `MM/DD/YYYY - HH:MM` with no zone. It is treated as `America/Los_Angeles` and converted to UTC epoch seconds in `src/time.ts`.
- The feed refreshes about every 3 minutes. ADA spaces are excluded from the counts.
- Status labels match the airport site's own thresholds by default: 0 to 49% Open, 50 to 74%
  Open (busy), 75 to 99% Limited, 100% Full (`src/status.ts`, `statusFor`). A fixed percent
  means the same word can describe very different real availability on lots of different
  sizes — Long-term at 75% still has ~190 open spaces, Short-term at 75% has ~48. Once a lot
  has at least `MIN_DAYS_FOR_TYPICAL_STATUS` (3) days of history, `/api/latest` switches that
  lot to `relativeStatusFor`: classify by how far the current reading deviates from *that
  lot's own* typical percent for the current hour (reusing the `/api/typical` baseline data)
  instead. 100%+ is always "Full" regardless of which classifier is active. Each lot in
  `/api/latest` reports which one produced its status via `statusBasis` (`"percent"` or
  `"typical"`), plus `typicalPercent`/`deviationPp` when it's the latter — surfaced as a
  tooltip on the status chip in the UI.

The endpoint was found in `window.drupalSettings.citizenParkingData` on the parking page. The page is server-rendered, so there was no XHR to sniff.

## Flight schedule feed (experimental)

`GET https://infax.com/webfids/sba/fids-sba.json`

Also no auth, no key. The airport's own arrivals-departures page embeds a "Real-Time Arrivals/Departures" widget from FIDS vendor Infax; that widget's own JS makes this same AJAX call, found by reading `js/main.js` inside the embedded iframe. It's the airport's chosen public flight board, just hosted on the vendor's domain rather than the airport's own.

```json
{"type":"D","rec":"118685","an":"United","ac":"UA","flt":"2865","city":"Denver","cc":"DEN","date":"09/10/26","sked":"0500","gate":"4","rem":"ON TIME","bag":" "}
```

This is a **live board, not a schedule archive**: it only ever returns today's (and sometimes tonight's overnight) flights, arrivals and departures mixed (`type` is `A` or `D`). There's no seat count or aircraft type, so a flight count is a proxy for passenger volume, not the real number. The point of tracking this at all is to eventually check whether departure volume in a given window correlates with the parking lots filling up faster, e.g. "5 departures around 9am" — but that's a hypothesis, not a claim this repo makes yet, and won't be worth testing until weeks of paired flight and occupancy data exist. `src/flights-source.ts` parses leniently (skips a malformed row rather than failing the whole poll), unlike the stricter parking parser, since this is a status board that can plausibly emit odd rows.

The board rarely posts a final status before dropping a flight. Measured over the first 4,595 stored flights (Sep to Nov 2026), only about 15% were last seen as `DEPARTED` or `ARRIVED`; most vanished about 20 to 25 minutes after their time while still saying `ON TIME` or `Now …`. About 4 in 10 flights carry a revised time in the remark itself (`Now   9:17A`), ranging from 18 minutes early to 76 minutes late (10th to 90th percentile). `src/flight-status.ts` reads that into an `expectedAt` time and a normalized `status` (`On time`, `Delayed`, `Early` at 5+ minutes off schedule, `Boarding`, `Departed`, `Arrived`, `Canceled`, or the remark as published if it's something new). `isFlightStale` (`src/api.ts`) flags a flight that's past its *expected* time and hasn't been reconfirmed in a couple of poll cycles, unless it already reached a confirmed outcome. The flight board (below) uses that flag, plus its own 30-minutes-past-expected rule for confirmed outcomes, to decide what's still worth showing.

Polled every 5 minutes by default (`FLIGHTS_POLL_INTERVAL_MS`), independently of the parking poller, with the same exponential backoff on failure. Disable with `POLL_FLIGHTS=0`.

## How it stores data

Storage sits behind the `ParkingStore` interface in `src/store.ts`, which also owns the schema and every SQL statement. The Node backend is `src/sqlite-store.ts` (node:sqlite, a single file at `data/parking.db`, WAL mode). The live site uses `src/d1-store.ts` (Cloudflare D1) behind the same interface, reusing the statements as written: the SQL is plain SQLite with positional `?N` parameters, and the schema has no pragmas.

One row per lot per distinct feed update:

| column | meaning |
|---|---|
| `lot_id`, `lot_name`, `total`, `occupied` | as published |
| `source_updated` | verbatim `updated` string, part of a unique key with `lot_id` |
| `source_updated_ts` | that timestamp as UTC epoch seconds, used for all time queries |
| `first_seen_utc`, `last_seen_utc` | when this process first and last observed the reading |

The poller runs every 5 minutes. When the feed has not changed since the last poll, the row is not duplicated; only `last_seen_utc` moves. That keeps the table honest about how often the source actually refreshes. Every poll attempt, successful or not, is logged in `polls`.

On failure the poller backs off exponentially, from 5 minutes up to 1 hour, and never retries faster than the base interval.

Flights are stored the same way, one row per distinct scheduled leg in a separate `flights` table, keyed on `(type, rec, flight_date)` — `rec` is the vendor's own record id. Unlike the parking upsert, `gate`/`remark`/`scheduled_local` are overwritten on conflict rather than left alone, since those are exactly the fields a live board updates (delays, gate changes) as the day goes on. Flight polls log to their own `flight_polls` table rather than `polls`, so the two pollers' health never gets mixed together.

## API

The public, versioned API is `/api/v1/latest` and `/api/v1/hourly?date=YYYY-MM-DD` (`src/api-v1.ts`), documented for outside readers at `public/api.html` and linked from the page footer as "Access the data". Those field names are a contract: add fields, never rename or remove them; breaking changes go in a `v2`. `v1` responses carry `Access-Control-Allow-Origin: *`. The docs page opens with a "For agents" prompt to paste into a coding agent.

The Worker counts `v1` requests and docs page views per UTC day in a D1 `api_usage` table (`src/usage.ts`: counts only, no IPs or user agents) and serves the totals at `/api/usage` for the counter on the docs page. Writes are batched to at most one per 5 seconds per isolate so a client hammering the API can't use up D1's daily write allowance, which the pollers share.

The routes below are the page's own and change with it:

| route | returns |
|---|---|
| `GET /api/latest` | newest reading per lot with free count, percent, status label (`statusBasis`/`typicalPercent`/`deviationPp` when typical-relative) and `stale` (no new airport timestamp in 30 min), plus `feed` (`stale`, `cause`), poller health and history stats |
| `GET /api/history?range=6h\|today\|7d\|30d\|all` | per-lot points `[epochSeconds, occupied, total]`, bucketed by average (1 min, 1 min, 15 min, 1 h, adaptive). `today` is a fixed local calendar day (midnight to midnight), not a rolling window — the axis has room for hours that haven't happened yet. Also returns `gaps`: stretches over 30 min where the airport's timestamp didn't advance, each with `cause` = `paused` (we polled fine, the airport didn't publish), `unreachable` (our requests failed), or `offline` (this tracker wasn't polling), read off the `polls` log. The chart shades them; nothing is interpolated |
| `GET /api/typical` | per-lot hour-of-day and hour-of-day-by-weekday baseline curves, for the chart's dashed reference lines |
| `GET /api/flights?since=&until=` | flights in a window (epoch seconds; defaults to today's local calendar day), plus poller health and storage stats. Each flight carries `stale` (see below) and `lastSeenAt`. Backs the on-page flight board, not just diagnostics |
| `GET /api/health` | 200 when the last poll is recent, 503 when polling is enabled but stale |

On the live site every route sits under `/sba-parking/`, and the Worker reuses responses at the edge for a short time (`EDGE_TTL_SECONDS` in `src/worker.ts`: 60 s for `latest`, 120 s for `history` and `flights`, 300 s for `typical`), so a response can be that much older than the database. `health` is never cached.

## Web page

Vanilla HTML, CSS, and JavaScript in `public/`, no framework, no build step. Refreshes itself every minute while visible. Light/dark follows the system. Lot colors are fixed by lot id so nothing ever recolors a series.

**Stat tiles.** One per lot: a ring chart and the open-spot count with a 30-minute trend badge in a row, a linear meter underneath, then a 24-hour bar chart of average open spots per hour, then a percent-available/open-count detail and the lot's address and price. The ring, the count, the bar chart, and the detail line all lead with *availability* (open spots), not occupancy — the only occupancy-framed number left on a tile is the status chip, which is about the airport's own occupancy thresholds on purpose.

**Occupancy chart.** All three lots on one axis, but the axis is percent *available*, not percent occupied — higher on the chart means more open parking. (Status labels, the meter fill, and trend badges still use occupied percent internally, since the airport's thresholds are defined that way; only the chart's own points and the tile's detail line get their wording flipped, via a small `avail()` helper.) The "Limited" reference line sits at 25% available, the same real threshold as 75%+ occupied. Range presets are `6h`, `Today` (a fixed local calendar day, not a rolling window), `7d`, `30d`, `All`. Hovering shows a crosshair tooltip with each lot's actual open-spot count (not a percent); arrow keys scrub the same way for keyboard users, with a live-region text equivalent since the chart itself is one opaque `role="img"` SVG. Hovering a stat tile dims every other lot's line so the hovered one stands out.

Two dashed reference-line toggles, "Typical day" (blended across all stored days) and "Same weekday" (only same-weekday days), overlay each lot's typical hour-of-day curve; "Same weekday" stays disabled until a lot has enough same-weekday history to mean anything. A third toggle group (per-flight vertical markers for arrivals/departures) exists in the code but is switched off by default (`FLIGHTS_CHART_MARKERS_ENABLED` in `app.js`) — even scoped to short ranges, one day's ~20 flights read as clutter; the flag is a one-line flip to bring it back.

**Flight board.** Two columns, Arrivals and Departures, at the bottom of the page, window tied to whichever chart range is selected. Airline + flight number are one linked cell to that flight's FlightAware page, when the airline maps to a known ICAO code (`AIRLINE_ICAO` in `app.js`); an unmapped airline just renders as text rather than a guessed, possibly-wrong link. Rows sort and show by expected time, with the scheduled time underneath when the board revised it; Delayed, Early and Canceled get a colored dot. Stale flights (see above) and flights that reached a confirmed outcome more than 30 minutes ago both drop off the list silently, no per-row warning, the same way the live source itself just stops listing a finished flight.

**Tracker status.** A collapsed footer panel with each poller's last result, interval, failures in the last 24 h, and the last error verbatim. The header only says a poll failed and points there, so an outage never puts a raw error at the top of the page.

**Footer.** A collapsed "About the data" disclosure (ADA-parking note, data sources, the flight-tracking caveat) instead of always-visible callout text, plus a site credit link.

## Live site: around805.com/sba-parking

A Cloudflare Worker (`src/worker.ts`, config in `wrangler.toml`) with D1 for storage:

| piece | how |
|---|---|
| page and API | `fetch` handler; strips `BASE_PATH` (`/sba-parking`), serves `public/` through the Static Assets binding, stamps asset hashes into `index.html` like the Node server does |
| pollers | one Cron Trigger `*/5 * * * *` running `pollOnce` and `pollFlightsOnce` side by side, so one failing never skips the other |
| backoff | a cron can't reschedule itself, so after failures it skips ticks until the same exponential wait the Node pollers use has passed (`dueForPoll`) |
| routing | route `around805.com/sba-parking*`. around805.com has a catch-all Redirect Rule to gutentag.world, and redirect rules run before Workers, so `/sba-parking` is listed in that rule's exceptions |

The page references its assets and API relative to itself, so the same `public/` works at the root (the Pi) and under the prefix.

```sh
pnpm worker:dev       # local Worker with a local D1; trigger crons at /__scheduled?cron=*/5+*+*+*+*
pnpm worker:deploy
pnpm exec wrangler secret put USER_AGENT   # contact address for the upstreams, kept out of the repo
pnpm exec wrangler tail                    # live logs, including each cron poll
```

`USER_AGENT` reaches `config.ts` through `process.env`, which the `nodejs_compat` flag fills from vars and secrets.

## Raspberry Pi: home-network backup viewer

The Pi no longer polls anything or serves the public. It keeps a nightly copy of D1 and runs the Node app against it, reachable only on the home network:

- `deploy/sba-parking.service` runs the app; a drop-in at `/etc/systemd/system/sba-parking.service.d/lan-viewer.conf` sets `POLL=0`, `POLL_FLIGHTS=0` and `HOST=192.168.1.23` (the Pi's LAN address). The page is at `http://192.168.1.23:3210/`.
- `deploy/backup-d1.sh`, run by `deploy/sba-parking-backup.timer` at 03:15 Pacific, exports D1 through its export API, rebuilds a SQLite file, keeps 14 nights in `data/backups/`, swaps the newest into `data/parking.db` and restarts the viewer. D1 pauses queries while an export runs, hence the hour.
- Credentials live in `/etc/sba-parking-backup.env` (mode 600): `CLOUDFLARE_API_TOKEN` (Account > D1 > Edit only), `CLOUDFLARE_ACCOUNT_ID`, `D1_DATABASE_ID`.

```sh
sudo cp deploy/sba-parking-backup.service deploy/sba-parking-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now sba-parking-backup.timer
sudo systemctl start sba-parking-backup.service   # run one now
journalctl -u sba-parking-backup -n 20
```

This Pi also runs a family call center behind its own tunnel (`cloudflared.service`). Nothing here touches it. The old `sba-parking` tunnel and `sba-parking.gutentag.world` were retired on 2026-11-26.

The Node app still runs anywhere on its own (`pnpm start`) with polling on, if the Worker ever needs replacing.

## Upstream etiquette

- One poll every 5 minutes for each feed, one process each. Never poll per page view; the page reads the local database.
- Descriptive `User-Agent` with a contact address, sent to both upstreams.
- Serve stale data on error rather than retrying hard.
- Airport parking office, if a heads-up ever seems warranted: (805) 967-2745, Reimagined Parking.
