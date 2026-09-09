// Baseline curves for the chart's dashed reference lines: "typical day" (every stored day
// blended by hour) and "typical day-of-week" (only same-weekday days blended by hour).
// Pure function over raw readings so it's easy to test without a database.

import { localTimeParts } from './time.ts'

export interface TypicalRawReading {
  lot_id: string
  lot_name: string
  total: number
  occupied: number
  source_updated_ts: number
}

export interface TypicalCurve {
  // 24 entries, hour-of-day 0-23. null where no reading has ever landed in that hour.
  hours: Array<number | null>
  samples: number[]
}

export interface TypicalDayOfWeek extends TypicalCurve {
  weekday: number // 0=Sun..6=Sat
  days: number // distinct local calendar dates that contributed, i.e. how many samples "typical" is really averaging
}

export interface TypicalLot {
  lotId: string
  lotName: string
  total: number
  day: TypicalCurve
  dayOfWeek: TypicalDayOfWeek[] // present only for weekdays with at least one reading
}

function emptyCurveAccum() {
  return { sum: Array(24).fill(0) as number[], count: Array(24).fill(0) as number[] }
}

function finishCurve(acc: { sum: number[]; count: number[] }): TypicalCurve {
  return {
    hours: acc.sum.map((s, h) => {
      const n = acc.count[h] ?? 0
      return n > 0 ? s / n : null
    }),
    samples: acc.count,
  }
}

// Arrays are always length 24 (one slot per hour-of-day); noUncheckedIndexedAccess just
// can't see that invariant, so route every hour-bucket write through this one spot.
function bump(sum: number[], count: number[], hour: number, value: number): void {
  sum[hour] = (sum[hour] ?? 0) + value
  count[hour] = (count[hour] ?? 0) + 1
}

export function computeTypical(rows: TypicalRawReading[], timeZone: string): TypicalLot[] {
  const byLot = new Map<
    string,
    {
      lotName: string
      total: number
      day: { sum: number[]; count: number[] }
      dow: Map<number, { sum: number[]; count: number[]; days: Set<string> }>
    }
  >()

  for (const r of rows) {
    let lot = byLot.get(r.lot_id)
    if (!lot) {
      lot = { lotName: r.lot_name, total: r.total, day: emptyCurveAccum(), dow: new Map() }
      byLot.set(r.lot_id, lot)
    }
    lot.total = Math.max(lot.total, r.total)
    // Percent, not raw occupied count: total capacity can change over time (see README),
    // so percent is the only value that's comparable across readings taken months apart.
    const percent = r.total > 0 ? Math.min(100, (r.occupied / r.total) * 100) : 0
    const { dateKey, hour, weekday } = localTimeParts(r.source_updated_ts, timeZone)

    bump(lot.day.sum, lot.day.count, hour, percent)

    let dow = lot.dow.get(weekday)
    if (!dow) {
      dow = { sum: Array(24).fill(0), count: Array(24).fill(0), days: new Set() }
      lot.dow.set(weekday, dow)
    }
    bump(dow.sum, dow.count, hour, percent)
    dow.days.add(dateKey)
  }

  const result: TypicalLot[] = []
  for (const [lotId, lot] of byLot) {
    const dayOfWeek = [...lot.dow.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([weekday, acc]) => ({ weekday, days: acc.days.size, ...finishCurve(acc) }))
    result.push({ lotId, lotName: lot.lotName, total: lot.total, day: finishCurve(lot.day), dayOfWeek })
  }
  return result.sort((a, b) => a.lotId.localeCompare(b.lotId))
}
