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

export interface TypicalRawRow {
  lot_id: string
  lot_name: string
  total: number
  occupied: number
  source_updated_ts: number
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
  /** Raw readings since `sinceTs`, for bucketing into typical-day / typical-day-of-week baselines. */
  typicalRaw(sinceTs: number): Promise<TypicalRawRow[]>
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

  close(): Promise<void>
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
]

/** Statements use positional `?N` parameters, which node:sqlite and D1 both accept. */
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

  latest: `
    SELECT r.lot_id, r.lot_name, r.total, r.occupied, r.source_updated, r.source_updated_ts, r.first_seen_utc, r.last_seen_utc
    FROM readings r
    JOIN (SELECT lot_id, MAX(source_updated_ts) AS ts FROM readings GROUP BY lot_id) m
      ON m.lot_id = r.lot_id AND m.ts = r.source_updated_ts
    ORDER BY r.lot_id`,

  // ?1 bucket seconds, ?2 since epoch seconds. Explicit CASTs keep the division integer
  // even when the driver binds numbers as REAL.
  history: `
    SELECT lot_id, lot_name,
           (source_updated_ts / CAST(?1 AS INTEGER)) * CAST(?1 AS INTEGER) AS bucket_ts,
           CAST(ROUND(AVG(occupied)) AS INTEGER) AS occupied,
           MAX(total) AS total,
           COUNT(*) AS samples
    FROM readings
    WHERE source_updated_ts >= ?2
    GROUP BY lot_id, bucket_ts
    ORDER BY bucket_ts, lot_id`,

  // ?1 since epoch seconds. Raw rows, not aggregated: hour-of-day and weekday depend on the
  // airport's local timezone, which SQLite can't resolve portably (no tz data, and D1 would
  // differ from node:sqlite's 'localtime' anyway), so that bucketing happens in JS instead.
  typicalRaw: `
    SELECT lot_id, lot_name, total, occupied, source_updated_ts
    FROM readings
    WHERE source_updated_ts >= ?1
    ORDER BY source_updated_ts`,

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
    SELECT (SELECT COUNT(*) FROM readings) AS readings,
           (SELECT MIN(source_updated_ts) FROM readings) AS earliest_ts,
           (SELECT MAX(source_updated_ts) FROM readings) AS latest_ts,
           (SELECT COUNT(*) FROM polls) AS polls,
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
    SELECT (SELECT COUNT(*) FROM flights) AS flights,
           (SELECT MIN(scheduled_ts) FROM flights) AS earliest_ts,
           (SELECT MAX(scheduled_ts) FROM flights) AS latest_ts,
           (SELECT COUNT(*) FROM flight_polls) AS polls,
           (SELECT COUNT(*) FROM flight_polls WHERE ok = 0 AND ts_utc >= ?1) AS failed_polls_24h`,
} as const
