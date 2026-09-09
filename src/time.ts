const partFormatters = new Map<string, Intl.DateTimeFormat>()

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let f = partFormatters.get(timeZone)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
    partFormatters.set(timeZone, f)
  }
  return f
}

// Offset (ms) of `timeZone` from UTC at the given instant. Positive means ahead of UTC.
function zoneOffsetMs(utcMs: number, timeZone: string): number {
  const parts = formatterFor(timeZone).formatToParts(new Date(utcMs))
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0)
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'))
  return asUtc - Math.floor(utcMs / 1000) * 1000
}

// Wall-clock fields in `timeZone` -> UTC epoch ms. Handles DST by re-checking the offset once.
export function zonedToUtcMs(
  fields: { year: number; month: number; day: number; hour: number; minute: number },
  timeZone: string,
): number {
  const guess = Date.UTC(fields.year, fields.month - 1, fields.day, fields.hour, fields.minute)
  const first = zoneOffsetMs(guess, timeZone)
  let utc = guess - first
  const second = zoneOffsetMs(utc, timeZone)
  if (second !== first) utc = guess - second
  return utc
}

// Source format: "MM/DD/YYYY - HH:MM" (the JSON escapes the slashes; JSON.parse undoes that).
const SOURCE_TS = /^(\d{2})\/(\d{2})\/(\d{4}) - (\d{2}):(\d{2})$/

export function parseSourceTimestamp(raw: string, timeZone: string): number {
  const m = SOURCE_TS.exec(raw.trim())
  if (!m) throw new Error(`unrecognized source timestamp: ${JSON.stringify(raw)}`)
  const [, mm, dd, yyyy, hh, min] = m
  const fields = {
    year: Number(yyyy),
    month: Number(mm),
    day: Number(dd),
    hour: Number(hh),
    minute: Number(min),
  }
  if (fields.month < 1 || fields.month > 12 || fields.day < 1 || fields.day > 31 || fields.hour > 23 || fields.minute > 59) {
    throw new Error(`out-of-range source timestamp: ${JSON.stringify(raw)}`)
  }
  return zonedToUtcMs(fields, timeZone)
}

export function isoFromEpochSeconds(seconds: number): string {
  return new Date(seconds * 1000).toISOString()
}

const localPartsFormatters = new Map<string, Intl.DateTimeFormat>()
function localPartsFormatterFor(timeZone: string): Intl.DateTimeFormat {
  let f = localPartsFormatters.get(timeZone)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      weekday: 'short',
    })
    localPartsFormatters.set(timeZone, f)
  }
  return f
}

const WEEKDAY_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }

// Local calendar date, hour (0-23), and weekday (0=Sun..6=Sat) for an epoch-seconds reading,
// in `timeZone`. Used to bucket readings into "typical day" / "typical day-of-week" baselines.
export function localTimeParts(epochSeconds: number, timeZone: string): { dateKey: string; hour: number; weekday: number } {
  const parts = localPartsFormatterFor(timeZone).formatToParts(new Date(epochSeconds * 1000))
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? ''
  const hour = Number(get('hour')) % 24 // hourCycle h23 can format midnight as "24"
  const weekday = WEEKDAY_INDEX[get('weekday')] ?? 0
  const dateKey = `${get('year')}-${get('month')}-${get('day')}`
  return { dateKey, hour, weekday }
}

function localDateFields(utcMs: number, timeZone: string): { year: number; month: number; day: number } {
  const parts = localPartsFormatterFor(timeZone).formatToParts(new Date(utcMs))
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0)
  return { year: get('year'), month: get('month'), day: get('day') }
}

// Local midnight (start of today) in `timeZone`, as UTC epoch ms. Used for the "today" chart
// range: a fixed calendar-day window rather than a rolling trailing-24h one.
export function localMidnightMs(utcMs: number, timeZone: string): number {
  const { year, month, day } = localDateFields(utcMs, timeZone)
  return zonedToUtcMs({ year, month, day, hour: 0, minute: 0 }, timeZone)
}

// Start of the next local calendar day. Built from date fields (not `utcMs + 24h`) so it's
// correct regardless of what local hour `utcMs` falls on, and Date.UTC's own overflow handling
// takes care of month/year rollover when `day + 1` exceeds the month.
export function nextLocalMidnightMs(utcMs: number, timeZone: string): number {
  const { year, month, day } = localDateFields(utcMs, timeZone)
  return zonedToUtcMs({ year, month, day: day + 1, hour: 0, minute: 0 }, timeZone)
}
