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
  type HistoryRow,
  type LatestRow,
  type ParkingStore,
  type PollRecord,
  type PollRow,
  type StoreStats,
  type TypicalRawRow,
} from './store.ts'

export class SqliteStore implements ParkingStore {
  #db: DatabaseSync
  #upsertReading
  #insertPoll
  #latest
  #history
  #typicalRaw
  #lastPoll
  #stats
  #upsertFlight
  #insertFlightPoll
  #flightsInRange
  #lastFlightPoll
  #flightStats

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.#db = new DatabaseSync(path)
    this.#db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;')
    for (const statement of SCHEMA_STATEMENTS) this.#db.exec(statement)

    this.#upsertReading = this.#db.prepare(SQL.upsertReading)
    this.#insertPoll = this.#db.prepare(SQL.insertPoll)
    this.#latest = this.#db.prepare(SQL.latest)
    this.#history = this.#db.prepare(SQL.history)
    this.#typicalRaw = this.#db.prepare(SQL.typicalRaw)
    this.#lastPoll = this.#db.prepare(SQL.lastPoll)
    this.#stats = this.#db.prepare(SQL.stats)
    this.#upsertFlight = this.#db.prepare(SQL.upsertFlight)
    this.#insertFlightPoll = this.#db.prepare(SQL.insertFlightPoll)
    this.#flightsInRange = this.#db.prepare(SQL.flightsInRange)
    this.#lastFlightPoll = this.#db.prepare(SQL.lastFlightPoll)
    this.#flightStats = this.#db.prepare(SQL.flightStats)
  }

  async recordReadings(readings: LotReading[], nowIso: string): Promise<{ inserted: number; seen: number }> {
    let inserted = 0
    this.#db.exec('BEGIN')
    try {
      for (const r of readings) {
        const row = this.#upsertReading.get(
          r.lotId, r.lotName, r.total, r.occupied, r.sourceUpdated, r.sourceUpdatedTs, nowIso,
        ) as { inserted: number } | undefined
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

  async typicalRaw(sinceTs: number): Promise<TypicalRawRow[]> {
    return this.#typicalRaw.all(sinceTs) as unknown as TypicalRawRow[]
  }

  async lastPoll(): Promise<PollRow | undefined> {
    return this.#lastPoll.get() as unknown as PollRow | undefined
  }

  async stats(): Promise<StoreStats> {
    const dayAgo = new Date(Date.now() - 24 * 3600_000).toISOString()
    return this.#stats.get(dayAgo) as unknown as StoreStats
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

  async flightStats(): Promise<FlightStoreStats> {
    const dayAgo = new Date(Date.now() - 24 * 3600_000).toISOString()
    return this.#flightStats.get(dayAgo) as unknown as FlightStoreStats
  }

  async close(): Promise<void> {
    this.#db.close()
  }
}
