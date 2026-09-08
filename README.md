# SBA Parking

Tracks how many spaces are free in Santa Barbara Airport's three public lots, stores every change the airport's feed publishes, and serves a small page that shows current status plus occupancy over time.

Zero runtime dependencies. Node 24 covers everything: `fetch`, `node:sqlite`, `node:http`, and native TypeScript type stripping. The only dev dependencies are `typescript` and `@types/node`, used for `pnpm typecheck`.

## Run

```sh
pnpm install          # dev deps only
pnpm start            # poller + web page on http://127.0.0.1:3210
pnpm dev              # same, restarts on file change
pnpm poll             # one poll, then exit (for cron)
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
- Status labels match the airport site's own thresholds: 0 to 49% Open, 50 to 74% Open (busy), 75 to 99% Limited, 100% Full.

The endpoint was found in `window.drupalSettings.citizenParkingData` on the parking page. The page is server-rendered, so there was no XHR to sniff.

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

## API

| route | returns |
|---|---|
| `GET /api/latest` | newest reading per lot with free count, percent, status label, plus poller health and history stats |
| `GET /api/history?range=6h\|24h\|7d\|30d\|all` | per-lot points `[epochSeconds, occupied, total]`, bucketed by average (1 min, 1 min, 15 min, 1 h, adaptive) |
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

## Cloudflare Workers port (planned)

The module boundaries map directly:

| today (Node) | on Workers |
|---|---|
| `sqlite-store.ts` | D1 backend implementing `ParkingStore` |
| `server.ts` (node:http) | `fetch` handler; `public/` served by Static Assets |
| `poller.ts` + `main.ts` (timer loop) | Cron Trigger `*/5 * * * *` calling `pollOnce` |
| `source.ts`, `time.ts`, `status.ts`, `public/` | unchanged |

Check first that Cloudflare egress can reach the `.gov` endpoint. If a WAF blocks it, the Pi keeps polling and posts readings to the Worker instead.

## Upstream etiquette

- One poll every 5 minutes, one process. Never poll per page view; the page reads the local database.
- Descriptive `User-Agent` with a contact address.
- Serve stale data on error rather than retrying hard.
- Airport parking office, if a heads-up ever seems warranted: (805) 967-2745, Reimagined Parking.
