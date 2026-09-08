import { config } from './config.ts'
import { parseSourceTimestamp } from './time.ts'

export interface LotReading {
  lotId: string
  lotName: string
  total: number
  occupied: number
  /** Verbatim `updated` string from the source, used for dedupe. */
  sourceUpdated: string
  /** `updated` converted to UTC epoch seconds. */
  sourceUpdatedTs: number
}

export class SourceError extends Error {
  httpStatus: number | undefined
  constructor(message: string, httpStatus?: number) {
    super(message)
    this.name = 'SourceError'
    this.httpStatus = httpStatus
  }
}

function asCount(value: unknown, field: string): number {
  // Every value in the feed is a string. Cast defensively.
  const n = typeof value === 'number' ? value : Number(String(value ?? '').trim())
  if (!Number.isInteger(n) || n < 0) throw new SourceError(`bad ${field}: ${JSON.stringify(value)}`)
  return n
}

function asText(value: unknown, field: string): string {
  const s = String(value ?? '').trim()
  if (!s) throw new SourceError(`missing ${field}`)
  return s
}

export function parseReadings(json: unknown, timeZone: string = config.sourceTimeZone): LotReading[] {
  if (!Array.isArray(json)) throw new SourceError('source payload is not an array')
  if (json.length === 0) throw new SourceError('source payload is empty')
  return json.map((row: unknown) => {
    if (typeof row !== 'object' || row === null) throw new SourceError('source row is not an object')
    const r = row as Record<string, unknown>
    const sourceUpdated = asText(r.updated, 'updated')
    return {
      lotId: asText(r.lot_id, 'lot_id'),
      lotName: asText(r.lot_name, 'lot_name'),
      total: asCount(r.total_spaces, 'total_spaces'),
      occupied: asCount(r.occupied_spaces, 'occupied_spaces'),
      sourceUpdated,
      sourceUpdatedTs: Math.floor(parseSourceTimestamp(sourceUpdated, timeZone) / 1000),
    }
  })
}

export async function fetchReadings(): Promise<{ readings: LotReading[]; httpStatus: number }> {
  let res: Response
  try {
    res = await fetch(config.sourceUrl, {
      headers: { 'user-agent': config.userAgent, accept: 'application/json' },
      signal: AbortSignal.timeout(config.fetchTimeoutMs),
    })
  } catch (err) {
    throw new SourceError(`fetch failed: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (!res.ok) throw new SourceError(`upstream returned HTTP ${res.status}`, res.status)
  let json: unknown
  try {
    json = await res.json()
  } catch (err) {
    throw new SourceError(`upstream body is not JSON: ${err instanceof Error ? err.message : String(err)}`, res.status)
  }
  return { readings: parseReadings(json), httpStatus: res.status }
}
