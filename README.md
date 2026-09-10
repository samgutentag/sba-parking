# SBA Parking

Tracks how many spaces are free in Santa Barbara Airport's three public lots, stores every change the airport's feed publishes, and serves a small page that shows current status plus occupancy over time.

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

Polled every 15 minutes by default (`FLIGHTS_POLL_INTERVAL_MS`), independently of the parking poller, with the same exponential backoff on failure. Disable with `POLL_FLIGHTS=0`.

## How it stores data

Storage sits behind the `ParkingStore` interface in `src/store.ts`, which also owns the schema and every SQL statement. The Node backend is `src/sqlite-store.ts` (node:sqlite, a single file at `data/parking.db`, WAL mode). The planned Cloudflare Workers port adds a D1 backend behind the same interface and reuses the statements as written: the SQL is plain SQLite with positional `?N` parameters, and the schema has no pragmas.

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

| route | returns |
|---|---|
| `GET /api/latest` | newest reading per lot with free count, percent, status label, plus poller health and history stats |
| `GET /api/history?range=6h\|24h\|7d\|30d\|all` | per-lot points `[epochSeconds, occupied, total]`, bucketed by average (1 min, 1 min, 15 min, 1 h, adaptive) |
| `GET /api/typical` | per-lot hour-of-day and hour-of-day-by-weekday baseline curves, for the chart's dashed reference lines |
| `GET /api/flights` | flights poller health, storage stats, and the last day's flight board — diagnostic only, no correlation with parking yet |
| `GET /api/health` | 200 when the last poll is recent, 503 when polling is enabled but stale |

## Web page

Vanilla HTML, CSS, and JavaScript in `public/`. Stat tile per lot, one occupancy chart with all three lots on a single percent axis, crosshair tooltip, keyboard navigation with arrow keys, a table view, range presets, and light/dark following the system. Lot colors are fixed by lot id so filtering never recolors a series. Refreshes itself every minute while visible.

## Deploy on a Raspberry Pi

`deploy/sba-parking.service` is a systemd unit. Copy the repo to `/opt/sba-parking`, then:

```sh
sudo cp deploy/sba-parking.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now sba-parking
journalctl -u sba-parking -f
```

Edit `Environment=` lines in the unit for `PORT`, `HOST`, and `USER_AGENT`. The database is a single file; back it up by copying `data/parking.db` while the service runs (WAL mode makes this safe) or with `sqlite3 data/parking.db ".backup out.db"`.

## Public URL: sba-parking.gutentag.world

Served from the same Pi via its own Cloudflare Tunnel, kept completely separate from any other
tunnel on that box (this Pi also runs a family call center, which must never be interrupted by
changes here):

- Tunnel name `sba-parking`, its own credentials file under `~/.cloudflared/`, its own config at
  `/etc/cloudflared/sba-parking-config.yml` (ingress: `sba-parking.gutentag.world` → `http://localhost:3210`).
- Its own systemd unit, `cloudflared-sba-parking.service`, running that config. Deliberately not
  reusing the box's existing `cloudflared.service`: that one is the call center's tunnel, and
  restarting it to pick up a config change would have interrupted it too, however briefly.
- Redeploying code here: `cd /opt/sba-parking && git pull && sudo systemctl restart sba-parking`.
  That only touches this app's own service, never the tunnel services or the call center.

## Cloudflare Workers port (planned)

The module boundaries map directly:

| today (Node) | on Workers |
|---|---|
| `sqlite-store.ts` | D1 backend implementing `ParkingStore` |
| `server.ts` (node:http) | `fetch` handler; `public/` served by Static Assets |
| `poller.ts` + `main.ts` (timer loop) | Cron Trigger `*/5 * * * *` calling `pollOnce` |
| `flights-poller.ts` | second Cron Trigger `*/15 * * * *` calling `pollFlightsOnce` |
| `source.ts`, `flights-source.ts`, `time.ts`, `status.ts`, `public/` | unchanged |

Check first that Cloudflare egress can reach the `.gov` endpoint. If a WAF blocks it, the Pi keeps polling and posts readings to the Worker instead.

## Upstream etiquette

- One poll every 5 minutes for parking, every 15 for flights, one process each. Never poll per page view; the page reads the local database.
- Descriptive `User-Agent` with a contact address, sent to both upstreams.
- Serve stale data on error rather than retrying hard.
- Airport parking office, if a heads-up ever seems warranted: (805) 967-2745, Reimagined Parking.
