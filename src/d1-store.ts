// Cloudflare backend: D1, which speaks the same SQLite as node:sqlite, so every statement and
// the schema come from store.ts unchanged. Multi-row writes go through batch(), which D1 runs
// as one transaction, the same all-or-nothing behavior as SqliteStore's BEGIN/COMMIT.

import type { LotReading } from './source.ts'
import type { FlightRecord } from './flights-source.ts'
import {
  SCHEMA_STATEMENTS,
  SQL,
  type FlightRow,
  type FlightStoreStats,
  type GapRow,
  type HistoryRow,
  type LatestRow,
  type ParkingStore,
  type PollCounts,
  type PollRecord,
  type PollRow,
  type StoreStats,
  type RollupRow,
  type CacheRow,
} from './store.ts'

export class D1Store implements ParkingStore {
  #db: D1Database
  #ready: Promise<unknown> | null = null

  constructor(db: D1Database) {
    this.#db = db
  }

  // CREATE ... IF NOT EXISTS is a no-op once the tables exist, so this runs once per isolate
  // rather than needing a separate migration step. A failure is logged, not thrown: the tables
  // almost always exist already, and a schema batch refused by a D1 limit mustn't take every
  // read down with it. If a table really is missing, the query itself fails with a clear error.
  #init(): Promise<unknown> {
    this.#ready ??= this.#db
      .batch(SCHEMA_STATEMENTS.map((s) => this.#db.prepare(s)))
      .catch((err) => console.error('schema check failed; continuing', err))
    return this.#ready
  }

  async #all<T>(sql: string, ...params: unknown[]): Promise<T[]> {
    await this.#init()
    const { results } = await this.#db.prepare(sql).bind(...params).all<T>()
    return results
  }

  async #first<T>(sql: string, ...params: unknown[]): Promise<T | undefined> {
    await this.#init()
    return (await this.#db.prepare(sql).bind(...params).first<T>()) ?? undefined
  }

  async #run(sql: string, ...params: unknown[]): Promise<void> {
    await this.#init()
    await this.#db.prepare(sql).bind(...params).run()
  }

  async #upsertBatch(statements: D1PreparedStatement[]): Promise<number> {
    if (!statements.length) return 0
    await this.#init()
    const results = await this.#db.batch<{ inserted: number }>(statements)
    return results.filter((r) => r.results[0]?.inserted).length
  }

  async recordReadings(readings: LotReading[], nowIso: string): Promise<{ inserted: number; seen: number }> {
    // Each reading's rollup upsert rides in the same batch (one transaction) right after it.
    const inserted = await this.#upsertBatch(
      readings.flatMap((r) => [
        this.#db.prepare(SQL.upsertReading).bind(
          r.lotId, r.lotName, r.total, r.occupied, r.sourceUpdated, r.sourceUpdatedTs, nowIso,
        ),
        this.#db.prepare(SQL.upsertRollup).bind(
          r.lotId, r.lotName, r.total, r.occupied, r.sourceUpdated, r.sourceUpdatedTs,
        ),
      ]),
    )
    return { inserted, seen: readings.length }
  }

  async recordPoll(poll: PollRecord, nowIso: string): Promise<void> {
    await this.#run(SQL.insertPoll, nowIso, poll.ok ? 1 : 0, poll.httpStatus ?? null, poll.newRows, poll.error ?? null)
  }

  latest(): Promise<LatestRow[]> {
    return this.#all<LatestRow>(SQL.latest)
  }

  history(sinceTs: number, bucketSeconds: number): Promise<HistoryRow[]> {
    return this.#all<HistoryRow>(SQL.history, Math.max(1, bucketSeconds), sinceTs)
  }

  historyRollup(sinceTs: number, bucketSeconds: number): Promise<HistoryRow[]> {
    return this.#all<HistoryRow>(SQL.historyRollup, bucketSeconds, sinceTs)
  }

  readingGapsRollup(sinceTs: number, minGapSeconds: number): Promise<GapRow[]> {
    return this.#all<GapRow>(SQL.readingGapsRollup, sinceTs, minGapSeconds)
  }

  rollupBetween(sinceTs: number, untilTs: number): Promise<RollupRow[]> {
    return this.#all<RollupRow>(SQL.rollupBetween, sinceTs, untilTs)
  }

  lastPoll(): Promise<PollRow | undefined> {
    return this.#first<PollRow>(SQL.lastPoll)
  }

  recentPolls(limit: number): Promise<PollRow[]> {
    return this.#all<PollRow>(SQL.recentPolls, limit)
  }

  async stats(): Promise<StoreStats> {
    const dayAgo = new Date(Date.now() - 24 * 3600_000).toISOString()
    const row = await this.#first<StoreStats>(SQL.stats, dayAgo)
    if (!row) throw new Error('stats query returned no row')
    return row
  }

  readingGaps(sinceTs: number, minGapSeconds: number): Promise<GapRow[]> {
    return this.#all<GapRow>(SQL.readingGaps, sinceTs, minGapSeconds)
  }

  async pollCounts(fromIso: string, toIso: string): Promise<PollCounts> {
    return (await this.#first<PollCounts>(SQL.pollCounts, fromIso, toIso)) ?? { ok: 0, failed: 0 }
  }

  async recordFlights(flights: FlightRecord[], nowIso: string): Promise<{ inserted: number; seen: number }> {
    const inserted = await this.#upsertBatch(
      flights.map((f) =>
        this.#db.prepare(SQL.upsertFlight).bind(
          f.type, f.rec, f.date, f.scheduledLocal, f.scheduledTs,
          f.airline, f.airlineCode, f.flightNumber, f.city, f.cityCode, f.gate, f.remark, nowIso,
        ),
      ),
    )
    return { inserted, seen: flights.length }
  }

  async recordFlightPoll(poll: PollRecord, nowIso: string): Promise<void> {
    await this.#run(SQL.insertFlightPoll, nowIso, poll.ok ? 1 : 0, poll.httpStatus ?? null, poll.newRows, poll.error ?? null)
  }

  flightsInRange(sinceTs: number, untilTs: number): Promise<FlightRow[]> {
    return this.#all<FlightRow>(SQL.flightsInRange, sinceTs, untilTs)
  }

  lastFlightPoll(): Promise<PollRow | undefined> {
    return this.#first<PollRow>(SQL.lastFlightPoll)
  }

  recentFlightPolls(limit: number): Promise<PollRow[]> {
    return this.#all<PollRow>(SQL.recentFlightPolls, limit)
  }

  async flightStats(): Promise<FlightStoreStats> {
    const dayAgo = new Date(Date.now() - 24 * 3600_000).toISOString()
    const row = await this.#first<FlightStoreStats>(SQL.flightStats, dayAgo)
    if (!row) throw new Error('flightStats query returned no row')
    return row
  }

  cacheGet(key: string): Promise<CacheRow | undefined> {
    return this.#first<CacheRow>(SQL.cacheGet, key)
  }

  async cacheSet(key: string, value: string, nowIso: string): Promise<void> {
    await this.#run(SQL.cacheSet, key, value, nowIso)
  }

  async close(): Promise<void> {}
}
