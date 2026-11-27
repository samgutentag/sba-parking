// Route handling shared by the Node server (server.ts) and the Cloudflare Worker (worker.ts).
// No node: imports here: each runtime turns the returned status and body into its own response.

import { v1Hourly, v1Latest, V1BadRequest } from './api-v1.ts'
import { config } from './config.ts'
import type { ParkingStore } from './store.ts'
import { relativeStatusFor, statusFor } from './status.ts'
import { isoFromEpochSeconds, localMidnightMs, localTimeParts, nextLocalMidnightMs } from './time.ts'
import { computeTypical, type TypicalLot } from './typical.ts'

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
// Below this many distinct days of *any* history, a lot's "typical for this hour" is really
// just "what happened once," so /api/latest falls back to the fixed-percent status instead.
const MIN_DAYS_FOR_TYPICAL_STATUS = 3
// Recomputing this is a full scan of up to 90 days of readings; cache it briefly so several
// clients (or one client's 30-minute refresh) don't each pay for it on every request. Shared
// by /api/typical and /api/latest so the latter doesn't pay for a second scan on every poll.
const TYPICAL_CACHE_MS = 5 * 60_000
let typicalCache: { at: number; sinceAt: string; untilAt: string; lots: TypicalLot[] } | null = null

async function getTypicalLots(db: ParkingStore): Promise<{ sinceAt: string; untilAt: string; lots: TypicalLot[] }> {
  if (typicalCache && Date.now() - typicalCache.at < TYPICAL_CACHE_MS) return typicalCache
  const now = Math.floor(Date.now() / 1000)
  const sinceTs = Math.max(0, now - TYPICAL_WINDOW_SECONDS)
  const rows = await db.typicalRaw(sinceTs)
  const lots = computeTypical(rows, config.sourceTimeZone)
  typicalCache = { at: Date.now(), sinceAt: isoFromEpochSeconds(sinceTs), untilAt: isoFromEpochSeconds(now), lots }
  return typicalCache
}

// The airport says it refreshes roughly every 3 minutes, so 30 minutes without its timestamp
// moving is well past normal jitter. Past this a reading is "stale" on the tiles and a gap in
// history is reported as an outage rather than a quiet stretch.
const FEED_STALE_SECONDS = 30 * 60

type GapCause = 'paused' | 'unreachable' | 'offline'

// Whose side a gap was on, read off our own poll log for that stretch: we kept polling fine
// and the timestamp just didn't move (the airport paused), our requests failed (the airport
// site was down or refusing us), or we barely polled at all (this tracker was offline).
async function gapCause(db: ParkingStore, fromTs: number, toTs: number): Promise<GapCause> {
  const { ok, failed } = await db.pollCounts(isoFromEpochSeconds(fromTs), isoFromEpochSeconds(toTs))
  const expected = Math.max(1, (toTs - fromTs) / (config.pollIntervalMs / 1000))
  if (ok >= expected * 0.5) return 'paused'
  if (failed > ok) return 'unreachable'
  return 'offline'
}

async function gapsPayload(db: ParkingStore, sinceTs: number, latestTs: number | null) {
  const now = Math.floor(Date.now() / 1000)
  const rows = await db.readingGaps(sinceTs, FEED_STALE_SECONDS)
  const spans = rows.map((r) => ({ fromTs: r.from_ts, toTs: r.to_ts, ongoing: false }))
  // A gap that hasn't ended yet: nothing new since the latest reading. Its right edge is now.
  if (latestTs !== null && now - latestTs > FEED_STALE_SECONDS) spans.push({ fromTs: latestTs, toTs: now, ongoing: true })
  return Promise.all(
    spans.map(async (g) => ({
      fromAt: isoFromEpochSeconds(g.fromTs),
      toAt: isoFromEpochSeconds(g.toTs),
      ongoing: g.ongoing,
      cause: await gapCause(db, g.fromTs, g.toTs),
    })),
  )
}

export class BadRequest extends Error {}

async function latestPayload(db: ParkingStore) {
  const [rows, last, stats, typical] = await Promise.all([db.latest(), db.lastPoll(), db.stats(), getTypicalLots(db)])
  const nowTs = Math.floor(Date.now() / 1000)
  const feedStale = stats.latest_ts !== null && nowTs - stats.latest_ts > FEED_STALE_SECONDS
  return {
    generatedAt: new Date().toISOString(),
    timeZone: config.sourceTimeZone,
    lots: rows.map((r) => {
      const typicalLot = typical.lots.find((l) => l.lotId === r.lot_id)
      const hour = localTimeParts(r.source_updated_ts, config.sourceTimeZone).hour
      const status =
        relativeStatusFor({
          total: r.total,
          occupied: r.occupied,
          typicalPercent: typicalLot?.day.hours[hour] ?? null,
          days: typicalLot?.days ?? 0,
          minDays: MIN_DAYS_FOR_TYPICAL_STATUS,
        }) ?? statusFor(r.total, r.occupied)
      return {
        lotId: r.lot_id,
        lotName: r.lot_name,
        total: r.total,
        occupied: r.occupied,
        free: Math.max(0, r.total - r.occupied),
        percent: status.percent,
        status: status.label,
        level: status.level,
        statusBasis: status.basis,
        typicalPercent: status.typicalPercent ?? null,
        deviationPp: status.deviationPp ?? null,
        sourceUpdated: r.source_updated,
        sourceUpdatedAt: isoFromEpochSeconds(r.source_updated_ts),
        lastSeenAt: r.last_seen_utc,
        stale: nowTs - r.source_updated_ts > FEED_STALE_SECONDS,
      }
    }),
    feed: {
      staleAfterMs: FEED_STALE_SECONDS * 1000,
      stale: feedStale,
      // Only worth a second query when there's something to explain.
      cause: feedStale && stats.latest_ts !== null ? await gapCause(db, stats.latest_ts, nowTs) : null,
    },
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

  const [rows, stats] = await Promise.all([db.history(sinceTs, bucket), db.stats()])
  const gaps = await gapsPayload(db, sinceTs, stats.latest_ts)
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
    // Outages longer than FEED_STALE_SECONDS, bounded by the readings on either side (the
    // first may start before sinceAt). cause: paused | unreachable | offline, see gapCause.
    gaps,
  }
}

async function typicalPayload(db: ParkingStore) {
  const { sinceAt, untilAt, lots } = await getTypicalLots(db)
  return {
    sinceAt,
    untilAt,
    timeZone: config.sourceTimeZone,
    minDaysForDayOfWeek: MIN_DAYS_FOR_DAY_OF_WEEK,
    lots,
  }
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
  // `Number('')` is 0, not NaN, so an explicitly-empty param has to be rejected before the
  // Number() conversion rather than relying on isFinite to catch it afterward.
  function epochParam(name: string, value: string | null, fallback: number): number {
    if (value === null) return fallback
    if (value.trim() === '' || !Number.isFinite(Number(value))) {
      throw new BadRequest(`${name} must be epoch seconds`)
    }
    return Number(value)
  }
  const sinceTs = epochParam('since', url.searchParams.get('since'), Math.floor(localMidnightMs(nowMs, config.sourceTimeZone) / 1000))
  const untilTs = epochParam('until', url.searchParams.get('until'), Math.floor(nextLocalMidnightMs(nowMs, config.sourceTimeZone) / 1000))
  if (untilTs < sinceTs) throw new BadRequest('until must be >= since')

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
      airlineCode: r.airline_code,
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

export interface ApiResult {
  status: number
  body: unknown
  headers?: Record<string, string>
}

// The v1 API is public and read-only, so any site's browser JavaScript may call it. The page's
// own routes stay same-origin.
const V1_HEADERS = { 'access-control-allow-origin': '*' }

async function handleV1(db: ParkingStore, pathname: string, url: URL): Promise<ApiResult> {
  try {
    if (pathname === '/api/v1/latest') return { status: 200, body: await v1Latest(db), headers: V1_HEADERS }
    if (pathname === '/api/v1/hourly') return { status: 200, body: await v1Hourly(db, url.searchParams.get('date')), headers: V1_HEADERS }
    return { status: 404, body: { error: 'not found' }, headers: V1_HEADERS }
  } catch (err) {
    if (err instanceof V1BadRequest) return { status: 400, body: { error: err.message }, headers: V1_HEADERS }
    throw err
  }
}

/** Answers an `/api/*` path, or returns null for anything else. `pathname` has any base path already stripped. */
export async function handleApi(db: ParkingStore, pathname: string, url: URL): Promise<ApiResult | null> {
  if (!pathname.startsWith('/api/')) return null
  if (pathname.startsWith('/api/v1/')) return handleV1(db, pathname, url)
  try {
    if (pathname === '/api/latest') return { status: 200, body: await latestPayload(db) }
    if (pathname === '/api/history') return { status: 200, body: await historyPayload(db, url) }
    if (pathname === '/api/typical') return { status: 200, body: await typicalPayload(db) }
    if (pathname === '/api/flights') return { status: 200, body: await flightsPayload(db, url) }
    if (pathname === '/api/health') {
      const last = await db.lastPoll()
      const stale = last ? Date.now() - Date.parse(last.ts_utc) > config.pollIntervalMs * 3 : true
      return {
        status: stale && config.pollEnabled ? 503 : 200,
        body: { ok: !stale || !config.pollEnabled, lastPollAt: last?.ts_utc ?? null, lastPollOk: last ? last.ok === 1 : null },
      }
    }
    return { status: 404, body: { error: 'not found' } }
  } catch (err) {
    if (err instanceof BadRequest) return { status: 400, body: { error: err.message } }
    throw err
  }
}
