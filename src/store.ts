// Storage contract shared by every backend. Node uses node:sqlite today; a Cloudflare
// Worker will use D1. Both speak SQLite, so the schema and statements live here once.

import type { LotReading } from './source.ts'
import type { FlightRecord } from './flights-source.ts'

export interface LatestRow {
  lot_id: string
  lot_name: string
  total: number
  occupied: number
  source_updated: string
  source_updated_ts: number
  first_seen_utc: string
  last_seen_utc: string
}

export interface HistoryRow {
  lot_id: string
  lot_name: string
  bucket_ts: number
  occupied: number
  total: number
  samples: number
}

/** One lot's readings within one 15-minute UTC bucket. Sums, not averages, so buckets combine exactly. */
export interface RollupRow {
  lot_id: string
  lot_name: string
  bucket_ts: number
  occupied_sum: number
  samples: number
  total: number
  first_ts: number
  last_ts: number
}

export interface PollRow {
  ts_utc: string
  ok: number
  http_status: number | null
  new_rows: number
  error: string | null
}

export interface StoreStats {
  readings: number
  earliest_ts: number | null
  latest_ts: number | null
  polls: number
  failed_polls_24h: number
}

export interface GapRow {
  from_ts: number
  to_ts: number
}

export interface PollCounts {
  ok: number
  failed: number
}

export interface PollRecord {
  ok: boolean
  httpStatus?: number
  newRows: number
  error?: string
}

export interface FlightRow {
  type: string
  rec: string
  flight_date: string
  scheduled_local: string
  scheduled_ts: number
  airline: string
  airline_code: string
  flight_number: string
  city: string
  city_code: string
  gate: string
  remark: string
  first_seen_utc: string
  last_seen_utc: string
}

export interface FlightStoreStats {
  flights: number
  earliest_ts: number | null
  latest_ts: number | null
  polls: number
  failed_polls_24h: number
}

// One store, two feeds: the flights methods below share the same SQLite file and connection
// as the parking ones (see sqlite-store.ts), just against separate tables, so there's no
// separate store class or wiring to stand up for the second poller.
export interface ParkingStore {
  /** Upsert one poll's readings. Identical readings only bump last_seen_utc. */
  recordReadings(readings: LotReading[], nowIso: string): Promise<{ inserted: number; seen: number }>
  recordPoll(poll: PollRecord, nowIso: string): Promise<void>
  latest(): Promise<LatestRow[]>
  history(sinceTs: number, bucketSeconds: number): Promise<HistoryRow[]>
  /** Chart points from the 15-minute rollup; `bucketSeconds` must be a multiple of 900. */
  historyRollup(sinceTs: number, bucketSeconds: number): Promise<HistoryRow[]>
  /** Feed outages longer than `minGapSeconds`, found between rollup buckets. */
  readingGapsRollup(sinceTs: number, minGapSeconds: number): Promise<GapRow[]>
  /** Rollup rows in [sinceTs, untilTs), for typical-day baselines and the public hourly endpoint. */
  rollupBetween(sinceTs: number, untilTs: number): Promise<RollupRow[]>
  lastPoll(): Promise<PollRow | undefined>
  /** Newest first. The Worker reads these to back off on failure, since its cron can't reschedule itself. */
  recentPolls(limit: number): Promise<PollRow[]>
  stats(): Promise<StoreStats>
  /** Stretches longer than `minGapSeconds` where the airport's own timestamp didn't advance. */
  readingGaps(sinceTs: number, minGapSeconds: number): Promise<GapRow[]>
  /** Our own poll outcomes strictly between two ISO timestamps, to say whose side a gap was on. */
  pollCounts(fromIso: string, toIso: string): Promise<PollCounts>

  /** Upsert one poll's flight board. An unchanged flight only bumps last_seen_utc. */
  recordFlights(flights: FlightRecord[], nowIso: string): Promise<{ inserted: number; seen: number }>
  recordFlightPoll(poll: PollRecord, nowIso: string): Promise<void>
  flightsInRange(sinceTs: number, untilTs: number): Promise<FlightRow[]>
  lastFlightPoll(): Promise<PollRow | undefined>
  recentFlightPolls(limit: number): Promise<PollRow[]>
  flightStats(): Promise<FlightStoreStats>

  /** Small computed values kept between requests (e.g. the typical-day baselines). */
  cacheGet(key: string): Promise<CacheRow | undefined>
  cacheSet(key: string, value: string, nowIso: string): Promise<void>

  close(): Promise<void>
}

export interface CacheRow {
  value: string
  updated_utc: string
}

/** Portable SQLite DDL. No pragmas here; those belong to the backend that supports them. */
export const SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS readings (
    id INTEGER PRIMARY KEY,
    lot_id TEXT NOT NULL,
    lot_name TEXT NOT NULL,
    total INTEGER NOT NULL,
    occupied INTEGER NOT NULL,
    source_updated TEXT NOT NULL,
    source_updated_ts INTEGER NOT NULL,
    first_seen_utc TEXT NOT NULL,
    last_seen_utc TEXT NOT NULL,
    UNIQUE (lot_id, source_updated)
  )`,
  'CREATE INDEX IF NOT EXISTS readings_lot_ts ON readings (lot_id, source_updated_ts)',
  'CREATE INDEX IF NOT EXISTS readings_ts ON readings (source_updated_ts)',
  `CREATE TABLE IF NOT EXISTS polls (
    id INTEGER PRIMARY KEY,
    ts_utc TEXT NOT NULL,
    ok INTEGER NOT NULL,
    http_status INTEGER,
    new_rows INTEGER NOT NULL DEFAULT 0,
    error TEXT
  )`,
  'CREATE INDEX IF NOT EXISTS polls_ts ON polls (ts_utc)',
  // One row per distinct scheduled flight leg. Identity is (type, rec, flight_date): `rec` is
  // the vendor's own record id, and flight_date guards against it ever being reused across
  // days. Gate/remark/time update in place as the live board changes; first_seen_utc doesn't.
  `CREATE TABLE IF NOT EXISTS flights (
    id INTEGER PRIMARY KEY,
    type TEXT NOT NULL,
    rec TEXT NOT NULL,
    flight_date TEXT NOT NULL,
    scheduled_local TEXT NOT NULL,
    scheduled_ts INTEGER NOT NULL,
    airline TEXT NOT NULL,
    airline_code TEXT NOT NULL,
    flight_number TEXT NOT NULL,
    city TEXT NOT NULL,
    city_code TEXT NOT NULL,
    gate TEXT NOT NULL,
    remark TEXT NOT NULL,
    first_seen_utc TEXT NOT NULL,
    last_seen_utc TEXT NOT NULL,
    UNIQUE (type, rec, flight_date)
  )`,
  'CREATE INDEX IF NOT EXISTS flights_scheduled_ts ON flights (scheduled_ts)',
  'CREATE INDEX IF NOT EXISTS flights_type_ts ON flights (type, scheduled_ts)',
  // Separate from `polls` on purpose: mixing the two feeds' poll history into one table would
  // make /api/health's staleness check reflect whichever poller happened to run last.
  `CREATE TABLE IF NOT EXISTS flight_polls (
    id INTEGER PRIMARY KEY,
    ts_utc TEXT NOT NULL,
    ok INTEGER NOT NULL,
    http_status INTEGER,
    new_rows INTEGER NOT NULL DEFAULT 0,
    error TEXT
  )`,
  'CREATE INDEX IF NOT EXISTS flight_polls_ts ON flight_polls (ts_utc)',
  // 15-minute rollup of readings, kept up to date on every new reading (see upsertRollup), so
  // charts longer than a few hours, the typical-day baselines and the hourly API never read raw
  // rows. On D1 every row read is billed, and this is about a fifth as many rows. WITHOUT
  // ROWID makes the primary key the table itself, so a time-range read touches each row once.
  // America/Los_Angeles is a whole-hour offset from UTC, so UTC quarter hours are local ones.
  `CREATE TABLE IF NOT EXISTS readings_15m (
    bucket_ts INTEGER NOT NULL,
    lot_id TEXT NOT NULL,
    lot_name TEXT NOT NULL,
    occupied_sum INTEGER NOT NULL,
    samples INTEGER NOT NULL,
    total INTEGER NOT NULL,
    first_ts INTEGER NOT NULL,
    last_ts INTEGER NOT NULL,
    PRIMARY KEY (bucket_ts, lot_id)
  ) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS cache (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_utc TEXT NOT NULL
  )`,
]

/**
 * Statements use positional `?N` parameters, which node:sqlite and D1 both accept.
 *
 * D1 bills every row a query reads, index entries included, so nothing that runs per page view
 * may scan a whole table: counts come from MAX(id) (ids are never deleted, so it equals the row
 * count) and time windows go through the timestamp indexes.
 */
export const SQL = {
  // Dedupe on (lot, source_updated): an identical reading only bumps last_seen_utc,
  // so the table reflects the source's real refresh cadence rather than ours.
  // `inserted` is 1 for a fresh row, 0 for a repeat.
  upsertReading: `
    INSERT INTO readings (lot_id, lot_name, total, occupied, source_updated, source_updated_ts, first_seen_utc, last_seen_utc)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)
    ON CONFLICT (lot_id, source_updated) DO UPDATE SET last_seen_utc = excluded.last_seen_utc
    RETURNING first_seen_utc = last_seen_utc AS inserted`,

  insertPoll: 'INSERT INTO polls (ts_utc, ok, http_status, new_rows, error) VALUES (?1, ?2, ?3, ?4, ?5)',

  // Every lot shares the feed's one timestamp, so the newest readings are the rows at the
  // newest timestamp: an index lookup instead of a per-lot MAX over the whole table.
  latest: `
    SELECT lot_id, lot_name, total, occupied, source_updated, source_updated_ts, first_seen_utc, last_seen_utc
    FROM readings
    WHERE source_updated_ts = (SELECT MAX(source_updated_ts) FROM readings)
    ORDER BY lot_id`,

  // ?1 bucket seconds, ?2 since epoch seconds. Explicit CASTs keep the division integer
  // even when the driver binds numbers as REAL.
  history: `
    SELECT lot_id, lot_name,
           (source_updated_ts / CAST(?1 AS INTEGER)) * CAST(?1 AS INTEGER) AS bucket_ts,
           CAST(ROUND(AVG(occupied)) AS INTEGER) AS occupied,
           MAX(total) AS total,
           COUNT(*) AS samples
    FROM readings INDEXED BY readings_ts
    WHERE source_updated_ts >= ?2
    GROUP BY lot_id, bucket_ts
    ORDER BY bucket_ts, lot_id`,

  // Folds one reading into its 15-minute bucket, but only if that reading was just inserted:
  // upsertReading leaves first_seen_utc = last_seen_utc on a fresh row and moves last_seen_utc
  // on a repeat, so a repeat poll of an unchanged feed never double-counts. Same params as
  // upsertReading (?1 lot, ?2 name, ?3 total, ?4 occupied, ?5 source_updated, ?6 ts), run right
  // after it in the same transaction. The CAST keeps the division integer when a driver binds
  // numbers as REAL.
  upsertRollup: `
    INSERT INTO readings_15m (bucket_ts, lot_id, lot_name, occupied_sum, samples, total, first_ts, last_ts)
    SELECT (CAST(?6 AS INTEGER) / 900) * 900, ?1, ?2, ?4, 1, ?3, ?6, ?6
    WHERE EXISTS (
      SELECT 1 FROM readings
      WHERE lot_id = ?1 AND source_updated = ?5 AND first_seen_utc = last_seen_utc
    )
    ON CONFLICT (bucket_ts, lot_id) DO UPDATE SET
      lot_name = excluded.lot_name,
      occupied_sum = occupied_sum + excluded.occupied_sum,
      samples = samples + 1,
      total = MAX(total, excluded.total),
      first_ts = MIN(first_ts, excluded.first_ts),
      last_ts = MAX(last_ts, excluded.last_ts)`,

  // Rebuilds the whole rollup from raw readings. A full scan, so only for setup: a fresh
  // database with history, or after importing readings. Safe to rerun.
  rebuildRollup: `
    INSERT OR REPLACE INTO readings_15m (bucket_ts, lot_id, lot_name, occupied_sum, samples, total, first_ts, last_ts)
    SELECT (source_updated_ts / 900) * 900, lot_id, MAX(lot_name), SUM(occupied), COUNT(*), MAX(total),
           MIN(source_updated_ts), MAX(source_updated_ts)
    FROM readings
    GROUP BY lot_id, (source_updated_ts / 900) * 900`,

  rollupEmpty: 'SELECT NOT EXISTS (SELECT 1 FROM readings_15m) AND EXISTS (SELECT 1 FROM readings) AS needs_rebuild',

  // ?1 bucket seconds (a multiple of 900), ?2 since epoch seconds. Averages weight each
  // 15-minute bucket by its readings, so the result matches averaging the raw rows.
  historyRollup: `
    SELECT lot_id, MAX(lot_name) AS lot_name,
           (bucket_ts / CAST(?1 AS INTEGER)) * CAST(?1 AS INTEGER) AS bucket_ts,
           CAST(ROUND(SUM(occupied_sum) * 1.0 / SUM(samples)) AS INTEGER) AS occupied,
           MAX(total) AS total,
           SUM(samples) AS samples
    FROM readings_15m
    WHERE bucket_ts >= (CAST(?2 AS INTEGER) / 900) * 900
    GROUP BY lot_id, (bucket_ts / CAST(?1 AS INTEGER)) * CAST(?1 AS INTEGER)
    ORDER BY bucket_ts, lot_id`,

  // ?1 since epoch seconds, ?2 minimum gap seconds. A gap longer than a bucket always crosses a
  // bucket boundary, so comparing each bucket's last reading with the next bucket's first finds
  // exactly the gaps readingGaps finds on raw rows, for any minimum over 15 minutes. Starts from
  // the last bucket before the window so a gap straddling its left edge still shows up.
  readingGapsRollup: `
    WITH b AS (
      SELECT bucket_ts, MIN(first_ts) AS first_ts, MAX(last_ts) AS last_ts FROM readings_15m
      WHERE bucket_ts >= COALESCE(
        (SELECT MAX(bucket_ts) FROM readings_15m WHERE bucket_ts < (CAST(?1 AS INTEGER) / 900) * 900),
        (CAST(?1 AS INTEGER) / 900) * 900)
      GROUP BY bucket_ts
    ), pairs AS (
      SELECT LAG(last_ts) OVER (ORDER BY bucket_ts) AS from_ts, first_ts AS to_ts FROM b
    )
    SELECT from_ts, to_ts FROM pairs
    WHERE from_ts IS NOT NULL AND to_ts - from_ts > ?2
    ORDER BY from_ts`,

  // ?1 since, ?2 until (exclusive), epoch seconds.
  rollupBetween: `
    SELECT lot_id, lot_name, bucket_ts, occupied_sum, samples, total, first_ts, last_ts
    FROM readings_15m
    WHERE bucket_ts >= ?1 AND bucket_ts < ?2
    ORDER BY bucket_ts, lot_id`,

  lastPoll: 'SELECT ts_utc, ok, http_status, new_rows, error FROM polls ORDER BY id DESC LIMIT 1',

  recentPolls: 'SELECT ts_utc, ok, http_status, new_rows, error FROM polls ORDER BY id DESC LIMIT ?1',

  // ?1 since epoch seconds, ?2 minimum gap seconds. Every lot shares the feed's one timestamp,
  // so gaps are found across distinct timestamps, not per lot. Starts from the last reading
  // *before* the window so a gap straddling its left edge still shows up.
  readingGaps: `
    WITH ts AS (
      SELECT DISTINCT source_updated_ts AS ts FROM readings
      WHERE source_updated_ts >= COALESCE((SELECT MAX(source_updated_ts) FROM readings WHERE source_updated_ts < ?1), ?1)
    ), pairs AS (
      SELECT LAG(ts) OVER (ORDER BY ts) AS from_ts, ts AS to_ts FROM ts
    )
    SELECT from_ts, to_ts FROM pairs
    WHERE from_ts IS NOT NULL AND to_ts - from_ts > ?2
    ORDER BY from_ts`,

  // ?1, ?2 ISO timestamps (exclusive). ISO strings from toISOString() sort chronologically.
  pollCounts: `
    SELECT COALESCE(SUM(ok = 1), 0) AS ok, COALESCE(SUM(ok = 0), 0) AS failed
    FROM polls WHERE ts_utc > ?1 AND ts_utc < ?2`,

  // ?1 ISO timestamp 24 hours ago.
  stats: `
    SELECT (SELECT COALESCE(MAX(id), 0) FROM readings) AS readings,
           (SELECT MIN(source_updated_ts) FROM readings) AS earliest_ts,
           (SELECT MAX(source_updated_ts) FROM readings) AS latest_ts,
           (SELECT COALESCE(MAX(id), 0) FROM polls) AS polls,
           (SELECT COUNT(*) FROM polls WHERE ok = 0 AND ts_utc >= ?1) AS failed_polls_24h`,

  // Dedupe on (type, rec, flight_date): an unchanged flight only bumps last_seen_utc, same
  // idea as upsertReading. Gate/remark/time DO get overwritten on conflict, unlike the parking
  // upsert, since those are exactly the fields a live board updates (delays, gate changes).
  upsertFlight: `
    INSERT INTO flights (type, rec, flight_date, scheduled_local, scheduled_ts, airline, airline_code, flight_number, city, city_code, gate, remark, first_seen_utc, last_seen_utc)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?13)
    ON CONFLICT (type, rec, flight_date) DO UPDATE SET
      scheduled_local = excluded.scheduled_local,
      scheduled_ts = excluded.scheduled_ts,
      gate = excluded.gate,
      remark = excluded.remark,
      last_seen_utc = excluded.last_seen_utc
    RETURNING first_seen_utc = last_seen_utc AS inserted`,

  insertFlightPoll: 'INSERT INTO flight_polls (ts_utc, ok, http_status, new_rows, error) VALUES (?1, ?2, ?3, ?4, ?5)',

  // ?1 since, ?2 until (epoch seconds), ordered so a caller can walk the window chronologically.
  flightsInRange: `
    SELECT type, rec, flight_date, scheduled_local, scheduled_ts, airline, airline_code,
           flight_number, city, city_code, gate, remark, first_seen_utc, last_seen_utc
    FROM flights
    WHERE scheduled_ts >= ?1 AND scheduled_ts <= ?2
    ORDER BY scheduled_ts`,

  lastFlightPoll: 'SELECT ts_utc, ok, http_status, new_rows, error FROM flight_polls ORDER BY id DESC LIMIT 1',

  recentFlightPolls: 'SELECT ts_utc, ok, http_status, new_rows, error FROM flight_polls ORDER BY id DESC LIMIT ?1',

  // ?1 ISO timestamp 24 hours ago.
  flightStats: `
    SELECT (SELECT COALESCE(MAX(id), 0) FROM flights) AS flights,
           (SELECT MIN(scheduled_ts) FROM flights) AS earliest_ts,
           (SELECT MAX(scheduled_ts) FROM flights) AS latest_ts,
           (SELECT COALESCE(MAX(id), 0) FROM flight_polls) AS polls,
           (SELECT COUNT(*) FROM flight_polls WHERE ok = 0 AND ts_utc >= ?1) AS failed_polls_24h`,

  cacheGet: 'SELECT value, updated_utc FROM cache WHERE key = ?1',

  cacheSet: `
    INSERT INTO cache (key, value, updated_utc) VALUES (?1, ?2, ?3)
    ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_utc = excluded.updated_utc`,
} as const
