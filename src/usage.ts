// Request counts for the public API and its docs page, shown as a counter on api.html.
// Worker-only, and kept out of ParkingStore on purpose: it's about this deployment's traffic,
// not the parking data, and the Pi's home viewer has nothing to count.
//
// Counts only: no IPs, no user agents, no cookies.

export type UsageKey = 'v1-latest' | 'v1-hourly' | 'docs'

const USAGE_KEYS: Record<string, UsageKey> = {
  '/api/v1/latest': 'v1-latest',
  '/api/v1/hourly': 'v1-hourly',
  '/api.html': 'docs',
}

export function usageKeyFor(path: string): UsageKey | null {
  return USAGE_KEYS[path] ?? null
}

const SCHEMA = `CREATE TABLE IF NOT EXISTS api_usage (
  day TEXT NOT NULL,
  route TEXT NOT NULL,
  hits INTEGER NOT NULL,
  PRIMARY KEY (day, route)
)`

const UPSERT = `
  INSERT INTO api_usage (day, route, hits) VALUES (?1, ?2, ?3)
  ON CONFLICT (day, route) DO UPDATE SET hits = hits + excluded.hits`

// D1's free tier allows 100k row writes a day and the pollers share that budget, so a client
// hammering the API mustn't be able to spend it. Hits pile up in memory and go out at most
// once per FLUSH_MS per isolate. Counts still pending when an isolate is evicted are lost,
// which makes the counter a slight undercount, never an overcount.
const FLUSH_MS = 5_000
let pending = new Map<UsageKey, number>()
let lastFlushMs = 0
let schemaReady: Promise<unknown> | null = null

function ensureSchema(db: D1Database): Promise<unknown> {
  schemaReady ??= db.exec(SCHEMA.replace(/\s+/g, ' ')).catch((err) => {
    schemaReady = null
    throw err
  })
  return schemaReady
}

async function flush(db: D1Database, batch: Map<UsageKey, number>): Promise<void> {
  await ensureSchema(db)
  const day = new Date().toISOString().slice(0, 10)
  await db.batch([...batch].map(([route, hits]) => db.prepare(UPSERT).bind(day, route, hits)))
}

export function recordUsage(db: D1Database, key: UsageKey, ctx: ExecutionContext): void {
  pending.set(key, (pending.get(key) ?? 0) + 1)
  const now = Date.now()
  if (now - lastFlushMs < FLUSH_MS) return
  lastFlushMs = now
  const batch = pending
  pending = new Map()
  // Counting must never break a request, so a failed write is logged and dropped.
  ctx.waitUntil(flush(db, batch).catch((err) => console.error('usage flush failed', err)))
}

export interface UsageSummary {
  since: string | null
  allTime: Record<UsageKey, number>
  last7Days: Record<UsageKey, number>
}

export async function usageSummary(db: D1Database): Promise<UsageSummary> {
  await ensureSchema(db)
  const weekAgo = new Date(Date.now() - 6 * 86400_000).toISOString().slice(0, 10)
  const { results } = await db
    .prepare(
      `SELECT route,
              SUM(hits) AS all_time,
              SUM(CASE WHEN day >= ?1 THEN hits ELSE 0 END) AS last_7,
              MIN(day) AS first_day
       FROM api_usage GROUP BY route`,
    )
    .bind(weekAgo)
    .all<{ route: UsageKey; all_time: number; last_7: number; first_day: string }>()
  const zero = (): Record<UsageKey, number> => ({ 'v1-latest': 0, 'v1-hourly': 0, docs: 0 })
  const summary: UsageSummary = { since: null, allTime: zero(), last7Days: zero() }
  for (const r of results) {
    if (!(r.route in summary.allTime)) continue
    summary.allTime[r.route] = r.all_time
    summary.last7Days[r.route] = r.last_7
    if (!summary.since || r.first_day < summary.since) summary.since = r.first_day
  }
  return summary
}
