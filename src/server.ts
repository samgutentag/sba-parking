import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import http from 'node:http'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { config } from './config.ts'
import type { ParkingStore } from './store.ts'
import { statusFor } from './status.ts'
import { isoFromEpochSeconds } from './time.ts'

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
const RANGES: Record<string, { seconds: number; bucket: number }> = {
  '6h': { seconds: 6 * 3600, bucket: 60 },
  '24h': { seconds: 24 * 3600, bucket: 60 },
  '7d': { seconds: 7 * 86400, bucket: 15 * 60 },
  '30d': { seconds: 30 * 86400, bucket: 3600 },
  '90d': { seconds: 90 * 86400, bucket: 3 * 3600 },
  all: { seconds: 0, bucket: 0 },
}

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
  let bucket = preset.bucket
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
    untilAt: isoFromEpochSeconds(now),
    bucketSeconds: bucket,
    timeZone: config.sourceTimeZone,
    // points: [epochSeconds, occupied, total]
    lots: [...lots.values()].sort((a, b) => a.lotId.localeCompare(b.lotId)),
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
