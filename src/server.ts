import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import http from 'node:http'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { config } from './config.ts'
import type { ParkingStore } from './store.ts'
import { statusFor } from './status.ts'
import { isoFromEpochSeconds, localMidnightMs, nextLocalMidnightMs } from './time.ts'
import { computeTypical, type TypicalLot } from './typical.ts'

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
}

// Range presets: window length and bucket size. Buckets keep the payload small on long ranges.
// `seconds` is unused for 'today' and 'all' — both compute their own since/until below.
const RANGES: Record<string, { seconds: number; bucket: number }> = {
  '6h': { seconds: 6 * 3600, bucket: 60 },
  '24h': { seconds: 24 * 3600, bucket: 60 }, // rolling trailing 24h; kept for internal/API use
  today: { seconds: 0, bucket: 60 }, // the chart's "24h" button: local midnight to midnight
  '7d': { seconds: 7 * 86400, bucket: 15 * 60 },
  '30d': { seconds: 30 * 86400, bucket: 3600 },
  '90d': { seconds: 90 * 86400, bucket: 3 * 3600 },
  all: { seconds: 0, bucket: 0 },
}

// "Typical day" / "typical day-of-week" baselines average over a rolling window, not all
// history, so the reference line tracks recent patterns (a rate change, a schedule shift)
// rather than getting diluted by month-old data forever.
const TYPICAL_WINDOW_SECONDS = 90 * 86400
// Below this many distinct same-weekday days, a day-of-week average is really just "repeat
// last Tuesday" dressed up as a trend. The frontend disables that toggle under this line.
const MIN_DAYS_FOR_DAY_OF_WEEK = 3
// Recomputing this is a full scan of up to 90 days of readings; cache it briefly so several
// clients (or one client's 30-minute refresh) don't each pay for it on every request.
const TYPICAL_CACHE_MS = 5 * 60_000
let typicalCache: { at: number; payload: unknown } | null = null

class BadRequest extends Error {}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  })
  res.end(text)
}

async function latestPayload(db: ParkingStore) {
  const [rows, last, stats] = await Promise.all([db.latest(), db.lastPoll(), db.stats()])
  return {
    generatedAt: new Date().toISOString(),
    timeZone: config.sourceTimeZone,
    lots: rows.map((r) => {
      const status = statusFor(r.total, r.occupied)
      return {
        lotId: r.lot_id,
        lotName: r.lot_name,
        total: r.total,
        occupied: r.occupied,
        free: Math.max(0, r.total - r.occupied),
        percent: status.percent,
        status: status.label,
        level: status.level,
        sourceUpdated: r.source_updated,
        sourceUpdatedAt: isoFromEpochSeconds(r.source_updated_ts),
        lastSeenAt: r.last_seen_utc,
      }
    }),
    poller: {
      enabled: config.pollEnabled,
      intervalMs: config.pollIntervalMs,
      lastPollAt: last?.ts_utc ?? null,
      lastPollOk: last ? last.ok === 1 : null,
      lastError: last?.error ?? null,
      failedLast24h: stats.failed_polls_24h,
    },
    history: {
      readings: stats.readings,
      earliestAt: stats.earliest_ts === null ? null : isoFromEpochSeconds(stats.earliest_ts),
      latestAt: stats.latest_ts === null ? null : isoFromEpochSeconds(stats.latest_ts),
    },
    notes: ['Counts exclude ADA spaces.', 'Source: flysba.santabarbaraca.gov, refreshed roughly every 3 minutes.'],
  }
}

async function historyPayload(db: ParkingStore, url: URL) {
  const rangeKey = url.searchParams.get('range') ?? '24h'
  const preset = RANGES[rangeKey]
  if (!preset) throw new BadRequest(`unknown range; use one of ${Object.keys(RANGES).join(', ')}`)

  const now = Math.floor(Date.now() / 1000)
  let sinceTs = preset.seconds > 0 ? now - preset.seconds : 0
  let untilTs = now
  let bucket = preset.bucket
  if (rangeKey === 'today') {
    // Fixed calendar-day window, not "now minus 24h": the axis spans the whole day so a flight
    // scheduled for 9pm still has a place to land even before it happens. Later hours (and any
    // flight markers in them) just have no occupancy data yet.
    sinceTs = Math.floor(localMidnightMs(Date.now(), config.sourceTimeZone) / 1000)
    untilTs = Math.floor(nextLocalMidnightMs(Date.now(), config.sourceTimeZone) / 1000)
  }
  if (rangeKey === 'all') {
    const stats = await db.stats()
    const span = stats.earliest_ts === null ? 0 : now - stats.earliest_ts
    // Aim for roughly 700 points per lot regardless of how long the poller has been running.
    bucket = Math.max(60, Math.ceil(span / 700 / 60) * 60)
    sinceTs = stats.earliest_ts ?? 0
  }

  const rows = await db.history(sinceTs, bucket)
  const lots = new Map<string, { lotId: string; lotName: string; total: number; points: Array<[number, number, number]> }>()
  for (const r of rows) {
    let lot = lots.get(r.lot_id)
    if (!lot) {
      lot = { lotId: r.lot_id, lotName: r.lot_name, total: r.total, points: [] }
      lots.set(r.lot_id, lot)
    }
    lot.total = Math.max(lot.total, r.total)
    lot.points.push([r.bucket_ts, r.occupied, r.total])
  }
  return {
    range: rangeKey,
    sinceAt: isoFromEpochSeconds(sinceTs),
    untilAt: isoFromEpochSeconds(untilTs),
    bucketSeconds: bucket,
    timeZone: config.sourceTimeZone,
    // points: [epochSeconds, occupied, total]
    lots: [...lots.values()].sort((a, b) => a.lotId.localeCompare(b.lotId)),
  }
}

async function typicalPayload(db: ParkingStore) {
  if (typicalCache && Date.now() - typicalCache.at < TYPICAL_CACHE_MS) return typicalCache.payload

  const now = Math.floor(Date.now() / 1000)
  const sinceTs = Math.max(0, now - TYPICAL_WINDOW_SECONDS)
  const rows = await db.typicalRaw(sinceTs)
  const lots: TypicalLot[] = computeTypical(rows, config.sourceTimeZone)

  const payload = {
    sinceAt: isoFromEpochSeconds(sinceTs),
    untilAt: isoFromEpochSeconds(now),
    timeZone: config.sourceTimeZone,
    minDaysForDayOfWeek: MIN_DAYS_FOR_DAY_OF_WEEK,
    lots,
  }
  typicalCache = { at: Date.now(), payload }
  return payload
}

// Diagnostic view of the flights feed: poller health, storage stats, and today's board so
// far. No correlation or prediction here on purpose — there isn't enough history yet to say
// anything about parking surges; this just proves the second poller is alive and storing.
// A flight is "stale" once it's past due and hasn't been reconfirmed in a couple of poll
// cycles — the live board (see flights-source.ts) simply drops completed arrivals rather than
// marking them done, unlike departures, which get a "DEPARTED" remark. So an old, unconfirmed
// "ON TIME" almost always means the flight fell off the board, not that it's still pending.
// A flight that already reached a terminal remark is never stale, no matter how long ago that
// was: that's a confirmed outcome, not a guess.
const FLIGHT_TERMINAL_REMARKS = new Set(['departed', 'landed', 'arrived', 'cancelled', 'canceled'])
function isFlightStale(scheduledTs: number, lastSeenUtc: string, remark: string, nowMs: number): boolean {
  if (FLIGHT_TERMINAL_REMARKS.has(remark.trim().toLowerCase())) return false
  const pastDue = nowMs > scheduledTs * 1000 + config.flightsPollIntervalMs
  const unconfirmed = nowMs - Date.parse(lastSeenUtc) > config.flightsPollIntervalMs * 2
  return pastDue && unconfirmed
}

async function flightsPayload(db: ParkingStore, url: URL) {
  const nowMs = Date.now()
  // Default window is today's local calendar day — the same span the flights page and the
  // chart's "today" range use. Pass explicit `since`/`until` (epoch seconds) to ask for a
  // different window, which is how the occupancy chart requests flights for 6h/7d views.
  const sinceParam = url.searchParams.get('since')
  const untilParam = url.searchParams.get('until')
  const sinceTs = sinceParam !== null ? Number(sinceParam) : Math.floor(localMidnightMs(nowMs, config.sourceTimeZone) / 1000)
  const untilTs = untilParam !== null ? Number(untilParam) : Math.floor(nextLocalMidnightMs(nowMs, config.sourceTimeZone) / 1000)
  if (!Number.isFinite(sinceTs) || !Number.isFinite(untilTs) || untilTs < sinceTs) {
    throw new BadRequest('since/until must be epoch seconds, with until >= since')
  }

  const [rows, last, stats] = await Promise.all([db.flightsInRange(sinceTs, untilTs), db.lastFlightPoll(), db.flightStats()])
  return {
    generatedAt: new Date().toISOString(),
    timeZone: config.sourceTimeZone,
    sinceAt: isoFromEpochSeconds(sinceTs),
    untilAt: isoFromEpochSeconds(untilTs),
    poller: {
      enabled: config.flightsPollEnabled,
      intervalMs: config.flightsPollIntervalMs,
      lastPollAt: last?.ts_utc ?? null,
      lastPollOk: last ? last.ok === 1 : null,
      lastError: last?.error ?? null,
      failedLast24h: stats.failed_polls_24h,
    },
    history: {
      flights: stats.flights,
      earliestAt: stats.earliest_ts === null ? null : isoFromEpochSeconds(stats.earliest_ts),
      latestAt: stats.latest_ts === null ? null : isoFromEpochSeconds(stats.latest_ts),
    },
    flights: rows.map((r) => ({
      type: r.type === 'A' ? 'arrival' : 'departure',
      airline: r.airline,
      flightNumber: r.flight_number,
      city: r.city,
      scheduledAt: isoFromEpochSeconds(r.scheduled_ts),
      gate: r.gate,
      remark: r.remark,
      lastSeenAt: r.last_seen_utc,
      stale: isFlightStale(r.scheduled_ts, r.last_seen_utc, r.remark, nowMs),
    })),
    notes: ["Live flight board, not a schedule archive. Source: Infax's FIDS widget, embedded on the airport's own arrivals-departures page."],
  }
}

async function serveStatic(pathname: string, res: http.ServerResponse): Promise<void> {
  const root = resolve(config.publicDir)
  const rel = normalize(decodeURIComponent(pathname === '/' ? '/index.html' : pathname))
  const file = join(root, rel)
  if (!file.startsWith(root + sep)) {
    res.writeHead(403).end('forbidden')
    return
  }
  let info
  try {
    info = await stat(file)
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('not found')
    return
  }
  if (!info.isFile()) {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('not found')
    return
  }
  res.writeHead(200, {
    'content-type': MIME[extname(file)] ?? 'application/octet-stream',
    'content-length': info.size,
    'cache-control': 'no-cache',
  })
  createReadStream(file).pipe(res)
}

export function createServer(db: ParkingStore): http.Server {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { allow: 'GET, HEAD' }).end()
        return
      }
      if (url.pathname === '/api/latest') return sendJson(res, 200, await latestPayload(db))
      if (url.pathname === '/api/history') return sendJson(res, 200, await historyPayload(db, url))
      if (url.pathname === '/api/typical') return sendJson(res, 200, await typicalPayload(db))
      if (url.pathname === '/api/flights') return sendJson(res, 200, await flightsPayload(db, url))
      if (url.pathname === '/api/health') {
        const last = await db.lastPoll()
        const stale = last ? Date.now() - Date.parse(last.ts_utc) > config.pollIntervalMs * 3 : true
        return sendJson(res, stale && config.pollEnabled ? 503 : 200, {
          ok: !stale || !config.pollEnabled,
          lastPollAt: last?.ts_utc ?? null,
          lastPollOk: last ? last.ok === 1 : null,
        })
      }
      if (url.pathname.startsWith('/api/')) return sendJson(res, 404, { error: 'not found' })
      await serveStatic(url.pathname, res)
    } catch (err) {
      if (err instanceof BadRequest) return sendJson(res, 400, { error: err.message })
      console.error(err)
      if (!res.headersSent) sendJson(res, 500, { error: 'internal error' })
      else res.end()
    }
  })
}
