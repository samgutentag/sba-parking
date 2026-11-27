// Public, versioned API for other services. Deliberately separate from the page's own /api/*
// routes, which carry chart and UI fields that change whenever the page does. Everything here
// is a contract: flat arrays of flat rows, field names fixed. Add fields if needed, never rename
// or remove them; anything breaking goes in a /api/v2/.

import { config } from './config.ts'
import type { ParkingStore } from './store.ts'
import { statusFor } from './status.ts'
import { localMidnightMs, localTimeParts, nextLocalMidnightMs, zonedToUtcMs } from './time.ts'

export class V1BadRequest extends Error {}

export interface V1LatestRow {
  lotId: string
  lot: string
  total: number
  open: number
  percentFull: number
  status: 'Open' | 'Limited' | 'Full'
  updatedAt: string
}

export interface V1HourlyRow {
  date: string
  hour: number
  lotId: string
  lot: string
  total: number
  open: number | null
  percentFull: number | null
}

// "Short-term Parking" -> "Short-term". lotId stays the stable key if the airport renames one.
function shortName(lotName: string): string {
  return lotName.replace(/\s+parking$/i, '').trim() || lotName
}

// Second precision is all the feed has; the milliseconds would only be noise in a contract.
function isoSeconds(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString().replace('.000Z', 'Z')
}

function percentFull(total: number, occupied: number): number {
  return total > 0 ? Math.min(100, Math.round((occupied / total) * 100)) : 0
}

export async function v1Latest(db: ParkingStore): Promise<V1LatestRow[]> {
  const rows = await db.latest()
  return rows.map((r) => {
    const occupied = Math.min(r.occupied, r.total)
    return {
      lotId: r.lot_id,
      lot: shortName(r.lot_name),
      total: r.total,
      open: Math.max(0, r.total - r.occupied),
      percentFull: percentFull(r.total, occupied),
      // Fixed thresholds, same as the airport's site, so the word is predictable. The page's own
      // typical-relative status would change meaning as history accumulates.
      status: statusFor(r.total, r.occupied).label,
      updatedAt: isoSeconds(r.source_updated_ts),
    }
  })
}

const DATE_PARAM = /^(\d{4})-(\d{2})-(\d{2})$/

/** [start, end) of a local calendar day as epoch seconds, plus its YYYY-MM-DD key. */
function localDay(dateParam: string | null, nowMs: number): { date: string; sinceTs: number; untilTs: number } {
  const tz = config.sourceTimeZone
  let anchorMs = nowMs
  if (dateParam !== null) {
    const m = DATE_PARAM.exec(dateParam)
    if (!m) throw new V1BadRequest('date must be YYYY-MM-DD')
    const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])]
    // Round-trip through Date to reject things like 2026-02-30 rather than rolling them over.
    const check = new Date(Date.UTC(year, month - 1, day))
    if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) {
      throw new V1BadRequest('date is not a real calendar date')
    }
    // Noon is never skipped or repeated by a DST change, so it always lands inside the day.
    anchorMs = zonedToUtcMs({ year, month, day, hour: 12, minute: 0 }, tz)
  }
  const sinceTs = Math.floor(localMidnightMs(anchorMs, tz) / 1000)
  const untilTs = Math.floor(nextLocalMidnightMs(anchorMs, tz) / 1000)
  return { date: localTimeParts(sinceTs, tz).dateKey, sinceTs, untilTs }
}

// Always 24 rows per lot, hours 0-23 local. On the fall-back day both 1 a.m. hours average
// together; on the spring-forward day 2 a.m. never happens and comes back null, like any hour
// with no readings.
export async function v1Hourly(db: ParkingStore, dateParam: string | null): Promise<V1HourlyRow[]> {
  const tz = config.sourceTimeZone
  const { date, sinceTs, untilTs } = localDay(dateParam, Date.now())
  const [lots, buckets] = await Promise.all([db.latest(), db.rollupBetween(sinceTs, untilTs)])

  // Sums and counts from the 15-minute rollup add up to exactly the raw hourly average.
  const sums = new Map<string, { occupied: number; total: number; n: number }>()
  for (const b of buckets) {
    const key = `${b.lot_id}|${localTimeParts(b.bucket_ts, tz).hour}`
    const s = sums.get(key) ?? { occupied: 0, total: 0, n: 0 }
    s.occupied += b.occupied_sum
    s.total = Math.max(s.total, b.total)
    s.n += b.samples
    sums.set(key, s)
  }

  const rows: V1HourlyRow[] = []
  for (let hour = 0; hour < 24; hour++) {
    for (const lot of lots) {
      const s = sums.get(`${lot.lot_id}|${hour}`)
      const total = s?.total || lot.total
      const occupied = s ? Math.min(Math.round(s.occupied / s.n), total) : null
      rows.push({
        date,
        hour,
        lotId: lot.lot_id,
        lot: shortName(lot.lot_name),
        total,
        open: occupied === null ? null : total - occupied,
        percentFull: occupied === null ? null : percentFull(total, occupied),
      })
    }
  }
  return rows
}
