import { fileURLToPath } from 'node:url'

const env = process.env

function positiveInt(value: string | undefined, fallback: number): number {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
}

export const config = {
  port: positiveInt(env.PORT, 3210),
  host: env.HOST ?? '127.0.0.1',
  dbPath: env.DB_PATH ?? fileURLToPath(new URL('../data/parking.db', import.meta.url)),
  publicDir: fileURLToPath(new URL('../public/', import.meta.url)),
  pollEnabled: env.POLL !== '0',
  pollIntervalMs: positiveInt(env.POLL_INTERVAL_MS, 5 * 60_000),
  maxBackoffMs: positiveInt(env.MAX_BACKOFF_MS, 60 * 60_000),
  fetchTimeoutMs: positiveInt(env.FETCH_TIMEOUT_MS, 15_000),
  sourceUrl: env.SOURCE_URL ?? 'https://flysba.santabarbaraca.gov/citizen-parking-data/latest',
  // The source's `updated` field carries no zone. The airport is in Santa Barbara.
  sourceTimeZone: 'America/Los_Angeles',
  userAgent:
    env.USER_AGENT ??
    'sba-parking-tracker/0.1 (personal parking availability tracker; set USER_AGENT to add contact info)',
} as const
