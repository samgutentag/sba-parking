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
