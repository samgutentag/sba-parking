// Today's flight board, fetched from the FIDS vendor widget embedded on the airport's own
// arrivals-departures page. See config.ts for how this was found. Unlike source.ts's parking
// feed (which throws on any malformed row), this parses leniently: it's a live status board,
// not a validated data API, and one odd row (a cancelled flight with a blank time, say)
// shouldn't take down the whole poll.

import { config } from './config.ts'
import { zonedToUtcMs } from './time.ts'

export interface FlightRecord {
  type: 'A' | 'D'
  rec: string
  airline: string
  airlineCode: string
  flightNumber: string
  city: string
  cityCode: string
  /** Verbatim MM/DD/YY from the source. Part of the dedupe key alongside type + rec. */
  date: string
  /** Verbatim HHmm (24h, local) from the source. */
  scheduledLocal: string
  /** date + scheduledLocal converted to UTC epoch seconds. */
  scheduledTs: number
  gate: string
  remark: string
}

export class FlightsSourceError extends Error {
  httpStatus: number | undefined
  constructor(message: string, httpStatus?: number) {
    super(message)
    this.name = 'FlightsSourceError'
    this.httpStatus = httpStatus
  }
}

function asText(value: unknown): string {
  return String(value ?? '').trim()
}

const DATE_RE = /^(\d{2})\/(\d{2})\/(\d{2})$/
const TIME_RE = /^(\d{2})(\d{2})$/

function scheduledTsFor(date: string, sked: string, timeZone: string): number | null {
  const d = DATE_RE.exec(date)
  const t = TIME_RE.exec(sked)
  if (!d || !t) return null
  const [, mm, dd, yy] = d
  const [, hh, min] = t
  const fields = { year: 2000 + Number(yy), month: Number(mm), day: Number(dd), hour: Number(hh), minute: Number(min) }
  if (fields.month < 1 || fields.month > 12 || fields.day < 1 || fields.day > 31 || fields.hour > 23 || fields.minute > 59) {
    return null
  }
  return Math.floor(zonedToUtcMs(fields, timeZone) / 1000)
}

function flightArrayFrom(json: unknown): unknown[] {
  if (typeof json !== 'object' || json === null) throw new FlightsSourceError('source payload is not an object')
  const flights = (json as Record<string, unknown>).flights
  if (typeof flights !== 'object' || flights === null) throw new FlightsSourceError('source payload missing "flights"')
  const flight = (flights as Record<string, unknown>).flight
  if (!Array.isArray(flight)) throw new FlightsSourceError('source payload missing flights.flight array')
  return flight
}

export function parseFlights(json: unknown, timeZone: string = config.sourceTimeZone): FlightRecord[] {
  const rows = flightArrayFrom(json)
  const out: FlightRecord[] = []
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) continue
    const r = row as Record<string, unknown>
    const type = asText(r.type).toUpperCase()
    if (type !== 'A' && type !== 'D') continue // skip anything that isn't a plain arrival/departure
    const rec = asText(r.rec)
    const date = asText(r.date)
    const sked = asText(r.sked)
    if (!rec || !date || !sked) continue // not enough to place this flight on a timeline
    const scheduledTs = scheduledTsFor(date, sked, timeZone)
    if (scheduledTs === null) continue
    out.push({
      type,
      rec,
      airline: asText(r.an),
      airlineCode: asText(r.ac),
      flightNumber: asText(r.flt),
      city: asText(r.city),
      cityCode: asText(r.cc),
      date,
      scheduledLocal: sked,
      scheduledTs,
      gate: asText(r.gate),
      remark: asText(r.rem),
    })
  }
  return out
}

export async function fetchFlights(): Promise<{ flights: FlightRecord[]; httpStatus: number }> {
  let res: Response
  try {
    res = await fetch(config.flightsSourceUrl, {
      headers: { 'user-agent': config.userAgent, accept: 'application/json' },
      signal: AbortSignal.timeout(config.fetchTimeoutMs),
    })
  } catch (err) {
    throw new FlightsSourceError(`fetch failed: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (!res.ok) throw new FlightsSourceError(`upstream returned HTTP ${res.status}`, res.status)
  let json: unknown
  try {
    json = await res.json()
  } catch (err) {
    throw new FlightsSourceError(`upstream body is not JSON: ${err instanceof Error ? err.message : String(err)}`, res.status)
  }
  return { flights: parseFlights(json), httpStatus: res.status }
}
