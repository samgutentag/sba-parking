// Cloudflare Worker entry: the same API and page as server.ts, plus the two pollers as Cron
// Triggers instead of timer loops. Served under BASE_PATH (e.g. /sba-parking) on a zone route,
// and also unprefixed, which is how `wrangler dev` serves it locally.

import { handleApi, type ApiResult } from './api.ts'
import { stampAssetUrls, VERSIONED_ASSETS } from './assets.ts'
import { config } from './config.ts'
import { D1Store } from './d1-store.ts'
import { pollFlightsOnce } from './flights-poller.ts'
import { pollOnce } from './poller.ts'
import type { PollRow } from './store.ts'
import { recordUsage, usageKeyFor, usageSummary } from './usage.ts'

interface Env {
  DB: D1Database
  ASSETS: Fetcher
  BASE_PATH?: string
}

// Must match [triggers] crons in wrangler.toml. One trigger runs both pollers: two triggers on
// the same schedule would be indistinguishable in controller.cron.
const POLL_CRON = '*/5 * * * *'

// How long each API response is reused at the edge before D1 is asked again. D1 bills every
// row a query reads, and an open page refreshes every minute, so this is what keeps one idle
// tab from spending the daily read allowance. Each is short next to how stale the data already
// is: the airport refreshes about every 3 minutes and we poll every 5.
const EDGE_TTL_SECONDS: Record<string, number> = {
  '/api/latest': 120,
  '/api/history': 300,
  '/api/flights': 300,
  '/api/typical': 300,
  '/api/v1/latest': 120,
  '/api/v1/hourly': 300,
  '/api/usage': 300,
}

// Cached copies are kept this long, well past their TTL, so that when D1 fails (an outage, or
// a daily limit) the page gets the last good answer instead of a 500.
const STALE_FALLBACK_SECONDS = 86400
const CACHED_AT_HEADER = 'x-sba-cached-at'

let store: D1Store | null = null
let storeDb: D1Database | null = null
function storeFor(env: Env): D1Store {
  if (!store || storeDb !== env.DB) {
    store = new D1Store(env.DB)
    storeDb = env.DB
  }
  return store
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
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

// The docs page's usage counter. Internal, like the page's other unversioned routes.
async function apiFor(env: Env, path: string, url: URL): Promise<ApiResult | null> {
  if (path === '/api/usage') return { status: 200, body: await usageSummary(env.DB) }
  return handleApi(storeFor(env), path, url)
}

async function serveApi(env: Env, path: string, url: URL, ctx: ExecutionContext): Promise<Response | null> {
  const ttl = EDGE_TTL_SECONDS[path]
  if (!ttl) {
    const api = await apiFor(env, path, url)
    return api && json(api.status, api.body, api.headers)
  }
  // The Cache API is a no-op on workers.dev, so caching only takes effect on the zone route.
  const cache = caches.default
  const cacheKey = new Request(url.toString(), { method: 'GET' })
  const hit = await cache.match(cacheKey)
  const fromCache = (res: Response, stale: boolean): Response => {
    const out = new Response(res.body, res)
    out.headers.set('cache-control', 'no-store')
    out.headers.delete(CACHED_AT_HEADER)
    if (stale) out.headers.set('x-sba-stale', '1')
    return out
  }
  if (hit && Date.now() - Number(hit.headers.get(CACHED_AT_HEADER)) < ttl * 1000) return fromCache(hit, false)

  let api
  try {
    api = await apiFor(env, path, url)
  } catch (err) {
    if (!hit) throw err
    console.error('serving stale after error', err)
    return fromCache(hit, true)
  }
  if (!api) return null
  const res = json(api.status, api.body, api.headers)
  if (api.status === 200) {
    const stored = res.clone()
    const headers = new Headers(stored.headers)
    headers.set('cache-control', `public, max-age=${STALE_FALLBACK_SECONDS}`)
    headers.set(CACHED_AT_HEADER, String(Date.now()))
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
  const page = await env.ASSETS.fetch(new URL('/index.html', origin))
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
  // Collapse leading slashes: new URL('//x', origin) would read "x" as a hostname.
  const assetPath = path.replace(/^\/+/, '/')
  return env.ASSETS.fetch(new Request(new URL(`${assetPath}${url.search}`, url.origin), request))
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

async function pollParking(db: D1Store, now: number): Promise<void> {
  if (!config.pollEnabled) return
  if (!dueForPoll(await db.recentPolls(BACKOFF_LOOKBACK), config.pollIntervalMs, now)) {
    console.log('poll skipped: backing off after failures')
    return
  }
  const outcome = await pollOnce(db)
  console.log(outcome.ok ? `poll ok: ${outcome.inserted} new of ${outcome.seen} lots` : `poll failed: ${outcome.error}`)
}

async function pollFlights(db: D1Store, now: number): Promise<void> {
  if (!config.flightsPollEnabled) return
  if (!dueForPoll(await db.recentFlightPolls(BACKOFF_LOOKBACK), config.flightsPollIntervalMs, now)) {
    console.log('flights poll skipped: backing off after failures')
    return
  }
  const outcome = await pollFlightsOnce(db)
  console.log(outcome.ok ? `flights poll ok: ${outcome.inserted} new of ${outcome.seen} flights` : `flights poll failed: ${outcome.error}`)
}

async function runCron(cron: string, db: D1Store): Promise<void> {
  if (cron !== POLL_CRON) {
    console.log(`cron ${cron}: nothing to do`)
    return
  }
  const now = Date.now()
  // Independent upstreams: one failing (or throwing on a D1 error) mustn't skip the other.
  const results = await Promise.allSettled([pollParking(db, now), pollFlights(db, now)])
  for (const r of results) if (r.status === 'rejected') console.error(r.reason)
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response(null, { status: 405, headers: { allow: 'GET, HEAD' } })
    }
    const url = new URL(request.url)
    const path = routePath(url, env.BASE_PATH ?? '')
    if (path instanceof Response) return path
    const usageKey = request.method === 'GET' ? usageKeyFor(path) : null
    if (usageKey) recordUsage(env.DB, usageKey, ctx)
    try {
      const api = await serveApi(env, path, url, ctx)
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
