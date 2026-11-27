// Node backend: node:sqlite, a single file on disk. Methods are async only to match
// the ParkingStore contract; node:sqlite itself is synchronous.

import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
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

export class SqliteStore implements ParkingStore {
  #db: DatabaseSync
  #upsertReading
  #insertPoll
  #latest
  #history
  #upsertRollup
  #historyRollup
  #readingGapsRollup
  #rollupBetween
  #lastPoll
  #recentPolls
  #stats
  #readingGaps
  #pollCounts
  #upsertFlight
  #insertFlightPoll
  #flightsInRange
  #lastFlightPoll
  #recentFlightPolls
  #flightStats
  #cacheGet
  #cacheSet

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.#db = new DatabaseSync(path)
    this.#db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;')
    for (const statement of SCHEMA_STATEMENTS) this.#db.exec(statement)

    this.#upsertReading = this.#db.prepare(SQL.upsertReading)
    this.#insertPoll = this.#db.prepare(SQL.insertPoll)
    this.#latest = this.#db.prepare(SQL.latest)
    this.#history = this.#db.prepare(SQL.history)
    this.#upsertRollup = this.#db.prepare(SQL.upsertRollup)
    this.#historyRollup = this.#db.prepare(SQL.historyRollup)
    this.#readingGapsRollup = this.#db.prepare(SQL.readingGapsRollup)
    this.#rollupBetween = this.#db.prepare(SQL.rollupBetween)
    // A database with readings from before the rollup existed (an older backup, say) gets it
    // built once here. Cheap locally; on D1 the same rebuild is a one-off manual step.
    const { needs_rebuild } = this.#db.prepare(SQL.rollupEmpty).get() as { needs_rebuild: number }
    if (needs_rebuild) this.#db.exec(SQL.rebuildRollup)
    this.#lastPoll = this.#db.prepare(SQL.lastPoll)
    this.#recentPolls = this.#db.prepare(SQL.recentPolls)
    this.#stats = this.#db.prepare(SQL.stats)
    this.#readingGaps = this.#db.prepare(SQL.readingGaps)
    this.#pollCounts = this.#db.prepare(SQL.pollCounts)
    this.#upsertFlight = this.#db.prepare(SQL.upsertFlight)
    this.#insertFlightPoll = this.#db.prepare(SQL.insertFlightPoll)
    this.#flightsInRange = this.#db.prepare(SQL.flightsInRange)
    this.#lastFlightPoll = this.#db.prepare(SQL.lastFlightPoll)
    this.#recentFlightPolls = this.#db.prepare(SQL.recentFlightPolls)
    this.#flightStats = this.#db.prepare(SQL.flightStats)
    this.#cacheGet = this.#db.prepare(SQL.cacheGet)
    this.#cacheSet = this.#db.prepare(SQL.cacheSet)
  }

  async recordReadings(readings: LotReading[], nowIso: string): Promise<{ inserted: number; seen: number }> {
    let inserted = 0
    this.#db.exec('BEGIN')
    try {
      for (const r of readings) {
        const row = this.#upsertReading.get(
          r.lotId, r.lotName, r.total, r.occupied, r.sourceUpdated, r.sourceUpdatedTs, nowIso,
        ) as { inserted: number } | undefined
        this.#upsertRollup.run(r.lotId, r.lotName, r.total, r.occupied, r.sourceUpdated, r.sourceUpdatedTs)
        if (row?.inserted) inserted++
      }
      this.#db.exec('COMMIT')
    } catch (err) {
      this.#db.exec('ROLLBACK')
      throw err
    }
    return { inserted, seen: readings.length }
  }

  async recordPoll(poll: PollRecord, nowIso: string): Promise<void> {
    this.#insertPoll.run(nowIso, poll.ok ? 1 : 0, poll.httpStatus ?? null, poll.newRows, poll.error ?? null)
  }

  async latest(): Promise<LatestRow[]> {
    return this.#latest.all() as unknown as LatestRow[]
  }

  async history(sinceTs: number, bucketSeconds: number): Promise<HistoryRow[]> {
    return this.#history.all(Math.max(1, bucketSeconds), sinceTs) as unknown as HistoryRow[]
  }

  async historyRollup(sinceTs: number, bucketSeconds: number): Promise<HistoryRow[]> {
    return this.#historyRollup.all(bucketSeconds, sinceTs) as unknown as HistoryRow[]
  }

  async readingGapsRollup(sinceTs: number, minGapSeconds: number): Promise<GapRow[]> {
    return this.#readingGapsRollup.all(sinceTs, minGapSeconds) as unknown as GapRow[]
  }

  async rollupBetween(sinceTs: number, untilTs: number): Promise<RollupRow[]> {
    return this.#rollupBetween.all(sinceTs, untilTs) as unknown as RollupRow[]
  }

  async lastPoll(): Promise<PollRow | undefined> {
    return this.#lastPoll.get() as unknown as PollRow | undefined
  }

  async recentPolls(limit: number): Promise<PollRow[]> {
    return this.#recentPolls.all(limit) as unknown as PollRow[]
  }

  async stats(): Promise<StoreStats> {
    const dayAgo = new Date(Date.now() - 24 * 3600_000).toISOString()
    return this.#stats.get(dayAgo) as unknown as StoreStats
  }

  async readingGaps(sinceTs: number, minGapSeconds: number): Promise<GapRow[]> {
    return this.#readingGaps.all(sinceTs, minGapSeconds) as unknown as GapRow[]
  }

  async pollCounts(fromIso: string, toIso: string): Promise<PollCounts> {
    return this.#pollCounts.get(fromIso, toIso) as unknown as PollCounts
  }

  async recordFlights(flights: FlightRecord[], nowIso: string): Promise<{ inserted: number; seen: number }> {
    let inserted = 0
    this.#db.exec('BEGIN')
    try {
      for (const f of flights) {
        const row = this.#upsertFlight.get(
          f.type, f.rec, f.date, f.scheduledLocal, f.scheduledTs,
          f.airline, f.airlineCode, f.flightNumber, f.city, f.cityCode, f.gate, f.remark, nowIso,
        ) as { inserted: number } | undefined
        if (row?.inserted) inserted++
      }
      this.#db.exec('COMMIT')
    } catch (err) {
      this.#db.exec('ROLLBACK')
      throw err
    }
    return { inserted, seen: flights.length }
  }

  async recordFlightPoll(poll: PollRecord, nowIso: string): Promise<void> {
    this.#insertFlightPoll.run(nowIso, poll.ok ? 1 : 0, poll.httpStatus ?? null, poll.newRows, poll.error ?? null)
  }

  async flightsInRange(sinceTs: number, untilTs: number): Promise<FlightRow[]> {
    return this.#flightsInRange.all(sinceTs, untilTs) as unknown as FlightRow[]
  }

  async lastFlightPoll(): Promise<PollRow | undefined> {
    return this.#lastFlightPoll.get() as unknown as PollRow | undefined
  }

  async recentFlightPolls(limit: number): Promise<PollRow[]> {
    return this.#recentFlightPolls.all(limit) as unknown as PollRow[]
  }

  async flightStats(): Promise<FlightStoreStats> {
    const dayAgo = new Date(Date.now() - 24 * 3600_000).toISOString()
    return this.#flightStats.get(dayAgo) as unknown as FlightStoreStats
  }

  async cacheGet(key: string): Promise<CacheRow | undefined> {
    return this.#cacheGet.get(key) as unknown as CacheRow | undefined
  }

  async cacheSet(key: string, value: string, nowIso: string): Promise<void> {
    this.#cacheSet.run(key, value, nowIso)
  }

  async close(): Promise<void> {
    this.#db.close()
  }
}
