// Storage contract shared by every backend. Node uses node:sqlite today; a Cloudflare
// Worker will use D1. Both speak SQLite, so the schema and statements live here once.

import type { LotReading } from './source.ts'

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

export interface PollRecord {
  ok: boolean
  httpStatus?: number
  newRows: number
  error?: string
}

export interface ParkingStore {
  /** Upsert one poll's readings. Identical readings only bump last_seen_utc. */
  recordReadings(readings: LotReading[], nowIso: string): Promise<{ inserted: number; seen: number }>
  recordPoll(poll: PollRecord, nowIso: string): Promise<void>
  latest(): Promise<LatestRow[]>
  history(sinceTs: number, bucketSeconds: number): Promise<HistoryRow[]>
  lastPoll(): Promise<PollRow | undefined>
  stats(): Promise<StoreStats>
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

  lastPoll: 'SELECT ts_utc, ok, http_status, new_rows, error FROM polls ORDER BY id DESC LIMIT 1',

  // ?1 ISO timestamp 24 hours ago.
  stats: `
    SELECT (SELECT COUNT(*) FROM readings) AS readings,
           (SELECT MIN(source_updated_ts) FROM readings) AS earliest_ts,
           (SELECT MAX(source_updated_ts) FROM readings) AS latest_ts,
           (SELECT COUNT(*) FROM polls) AS polls,
           (SELECT COUNT(*) FROM polls WHERE ok = 0 AND ts_utc >= ?1) AS failed_polls_24h`,
} as const
