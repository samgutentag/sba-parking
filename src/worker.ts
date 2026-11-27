// Cloudflare Worker entry: the same API and page as server.ts, plus the two pollers as Cron
// Triggers instead of timer loops. Served under BASE_PATH (e.g. /sba-parking) on a zone route,
// and also unprefixed so the workers.dev URL works for testing.

import { handleApi } from './api.ts'
import { stampAssetUrls, VERSIONED_ASSETS } from './assets.ts'
import { config } from './config.ts'
import { D1Store } from './d1-store.ts'
import { pollFlightsOnce } from './flights-poller.ts'
import { pollOnce } from './poller.ts'
import type { PollRow } from './store.ts'

interface Env {
  DB: D1Database
  ASSETS: Fetcher
  BASE_PATH?: string
}

// Must match [triggers] crons in wrangler.toml.
const PARKING_CRON = '*/5 * * * *'
const FLIGHTS_CRON = '*/15 * * * *'

// How long each API response is reused at the edge before D1 is asked again. D1 bills by rows
// scanned, and /api/typical and long /api/history ranges scan most of the table, so without
// this every page view pays for a full scan. Each is short next to how stale the data already
// is: the airport refreshes about every 3 minutes and we poll every 5.
const EDGE_TTL_SECONDS: Record<string, number> = {
  '/api/latest': 60,
  '/api/history': 120,
  '/api/flights': 120,
  '/api/typical': 300,
}

let store: D1Store | null = null
let storeDb: D1Database | null = null
function storeFor(env: Env): D1Store {
  if (!store || storeDb !== env.DB) {
    store = new D1Store(env.DB)
    storeDb = env.DB
  }
  return store
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

/** The request path with BASE_PATH removed, or a Response when the bare prefix needs its trailing slash. */
function routePath(url: URL, basePath: string): string | Response {
  if (!basePath) return url.pathname
  if (url.pathname === basePath) {
    // Relative asset and API URLs in the page only resolve under the prefix with a trailing slash.
    return Response.redirect(`${url.origin}${basePath}/${url.search}`, 308)
  }
  if (url.pathname.startsWith(`${basePath}/`)) return url.pathname.slice(basePath.length)
  return url.pathname
}

async function serveApi(db: D1Store, path: string, url: URL, ctx: ExecutionContext): Promise<Response | null> {
  const ttl = EDGE_TTL_SECONDS[path]
  // The Cache API is a no-op on workers.dev, so caching only takes effect on the zone route.
  const cache = caches.default
  const cacheKey = new Request(url.toString(), { method: 'GET' })
  if (ttl) {
    const hit = await cache.match(cacheKey)
    if (hit) {
      const res = new Response(hit.body, hit)
      res.headers.set('cache-control', 'no-store')
      return res
    }
  }
  const api = await handleApi(db, path, url)
  if (!api) return null
  const res = json(api.status, api.body)
  if (ttl && api.status === 200) {
    const stored = res.clone()
    const headers = new Headers(stored.headers)
    headers.set('cache-control', `public, max-age=${ttl}`)
    ctx.waitUntil(cache.put(cacheKey, new Response(stored.body, { status: 200, headers })))
  }
  return res
}

let indexHtml: Promise<string> | null = null

async function sha256Prefix(res: Response): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await res.arrayBuffer())
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 10)
}

// Same stamping as server.ts, built once per isolate. A deploy always starts fresh isolates.
async function buildIndexHtml(env: Env, origin: string): Promise<string> {
  const page = await env.ASSETS.fetch(new URL('/', origin))
  if (!page.ok) throw new Error(`index.html -> HTTP ${page.status}`)
  const hashes: Record<string, string> = {}
  for (const asset of VERSIONED_ASSETS) {
    const res = await env.ASSETS.fetch(new URL(`/${asset}`, origin))
    if (!res.ok) throw new Error(`${asset} -> HTTP ${res.status}`)
    hashes[asset] = await sha256Prefix(res)
  }
  return stampAssetUrls(await page.text(), hashes)
}

async function serveStatic(env: Env, path: string, request: Request, url: URL): Promise<Response> {
  if (path === '/' || path === '/index.html') {
    indexHtml ??= buildIndexHtml(env, url.origin).catch((err) => {
      indexHtml = null
      throw err
    })
    return new Response(request.method === 'HEAD' ? null : await indexHtml, {
      headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' },
    })
  }
  return env.ASSETS.fetch(new Request(new URL(`${path}${url.search}`, url.origin), request))
}

// Mirrors the Node pollers' backoff: after k consecutive failures, wait interval * 2^(k-1),
// capped at maxBackoffMs. A cron fires on a fixed schedule, so instead of rescheduling we
// skip ticks until that wait has passed. Slack absorbs cron jitter so a healthy feed never
// skips a tick.
const CRON_SLACK_MS = 60_000
function dueForPoll(recent: PollRow[], intervalMs: number, nowMs: number): boolean {
  let failures = 0
  for (const p of recent) {
    if (p.ok === 1) break
    failures++
  }
  const newest = recent[0]
  if (failures === 0 || !newest) return true
  const waitMs = Math.min(intervalMs * 2 ** (failures - 1), config.maxBackoffMs)
  return nowMs - Date.parse(newest.ts_utc) >= waitMs - CRON_SLACK_MS
}

// Enough history to reach the backoff cap from either interval.
const BACKOFF_LOOKBACK = 8

async function runCron(cron: string, db: D1Store): Promise<void> {
  const now = Date.now()
  if (cron === PARKING_CRON && config.pollEnabled) {
    if (!dueForPoll(await db.recentPolls(BACKOFF_LOOKBACK), config.pollIntervalMs, now)) {
      console.log('poll skipped: backing off after failures')
      return
    }
    const outcome = await pollOnce(db)
    console.log(outcome.ok ? `poll ok: ${outcome.inserted} new of ${outcome.seen} lots` : `poll failed: ${outcome.error}`)
    return
  }
  if (cron === FLIGHTS_CRON && config.flightsPollEnabled) {
    if (!dueForPoll(await db.recentFlightPolls(BACKOFF_LOOKBACK), config.flightsPollIntervalMs, now)) {
      console.log('flights poll skipped: backing off after failures')
      return
    }
    const outcome = await pollFlightsOnce(db)
    console.log(outcome.ok ? `flights poll ok: ${outcome.inserted} new of ${outcome.seen} flights` : `flights poll failed: ${outcome.error}`)
    return
  }
  console.log(`cron ${cron}: nothing to do`)
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response(null, { status: 405, headers: { allow: 'GET, HEAD' } })
    }
    const url = new URL(request.url)
    const path = routePath(url, env.BASE_PATH ?? '')
    if (path instanceof Response) return path
    try {
      const api = await serveApi(storeFor(env), path, url, ctx)
      if (api) return api
      return await serveStatic(env, path, request, url)
    } catch (err) {
      console.error(err)
      return json(500, { error: 'internal error' })
    }
  },

  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    await runCron(controller.cron, storeFor(env))
  },
} satisfies ExportedHandler<Env>
