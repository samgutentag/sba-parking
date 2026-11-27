// Mirrors poller.ts's fetch/backoff shape exactly, kept as its own copy rather than a shared
// abstraction: the two pollers hit different, independent upstreams (parking vs. the Infax
// flight board) and should be free to fail, back off, and be disabled independently, without
// a shared retry helper coupling their behavior together.

import { config } from './config.ts'
import type { ParkingStore } from './store.ts'
import { fetchFlights, FlightsSourceError } from './flights-source.ts'

export interface FlightsPollOutcome {
  ok: boolean
  inserted: number
  seen: number
  httpStatus?: number
  error?: string
}

export async function pollFlightsOnce(db: ParkingStore): Promise<FlightsPollOutcome> {
  const now = new Date().toISOString()
  try {
    const { flights, httpStatus } = await fetchFlights()
    const { inserted, seen } = await db.recordFlights(flights, now)
    await db.recordFlightPoll({ ok: true, httpStatus, newRows: inserted }, now)
    return { ok: true, inserted, seen, httpStatus }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const httpStatus = err instanceof FlightsSourceError ? err.httpStatus : undefined
    await db.recordFlightPoll({ ok: false, httpStatus, newRows: 0, error: message }, now)
    return { ok: false, inserted: 0, seen: 0, httpStatus, error: message }
  }
}

export interface FlightsPoller {
  stop(): void
}

// Polls on a fixed interval; on failure backs off exponentially up to maxBackoffMs, same
// policy as the parking poller. The flight board changes far less often than occupancy, so
// the default interval is longer (see config.flightsPollIntervalMs).
export function startFlightsPoller(db: ParkingStore, log: (line: string) => void = console.log): FlightsPoller {
  let timer: ReturnType<typeof setTimeout> | undefined
  let backoffMs = 0
  let stopped = false

  const tick = async () => {
    if (stopped) return
    const outcome = await pollFlightsOnce(db)
    let delay = config.flightsPollIntervalMs
    if (outcome.ok) {
      backoffMs = 0
      log(`flights poll ok: ${outcome.inserted} new of ${outcome.seen} flights`)
    } else {
      backoffMs = backoffMs === 0 ? config.flightsPollIntervalMs : Math.min(backoffMs * 2, config.maxBackoffMs)
      delay = backoffMs
      log(`flights poll failed: ${outcome.error} (next attempt in ${Math.round(delay / 1000)}s)`)
    }
    if (!stopped) timer = setTimeout(tick, delay)
  }

  void tick()
  return {
    stop() {
      stopped = true
      if (timer) clearTimeout(timer)
    },
  }
}
