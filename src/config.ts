// On Workers, process.env comes from wrangler.toml [vars] and secrets (nodejs_compat).
const env = process.env

function positiveInt(value: string | undefined, fallback: number): number {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
}

export const config = {
  port: positiveInt(env.PORT, 3210),
  host: env.HOST ?? '127.0.0.1',
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

  // Flight schedule feed. This backs the "Real-Time Arrivals/Departures" widget embedded on
  // the airport's own arrivals-departures page (an iframe to Infax's hosted FIDS product), so
  // it's data the airport itself chose to publish, even though it lives on a different host
  // than the parking feed. Found the same way: reading the page's own JS for its AJAX call.
  // It's a live board (today's flights only), not a history, so there's nothing to correlate
  // against parking occupancy until this has been polled and stored for a while.
  flightsPollEnabled: env.POLL_FLIGHTS !== '0',
  flightsPollIntervalMs: positiveInt(env.FLIGHTS_POLL_INTERVAL_MS, 5 * 60_000),
  flightsSourceUrl: env.FLIGHTS_SOURCE_URL ?? 'https://infax.com/webfids/sba/fids-sba.json',
} as const
