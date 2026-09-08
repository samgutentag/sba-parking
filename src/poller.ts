import { config } from './config.ts'
import type { ParkingStore } from './store.ts'
import { fetchReadings, SourceError } from './source.ts'

export interface PollOutcome {
  ok: boolean
  inserted: number
  seen: number
  httpStatus?: number
  error?: string
}

export async function pollOnce(db: ParkingStore): Promise<PollOutcome> {
  const now = new Date().toISOString()
  try {
    const { readings, httpStatus } = await fetchReadings()
    const { inserted, seen } = await db.recordReadings(readings, now)
    await db.recordPoll({ ok: true, httpStatus, newRows: inserted }, now)
    return { ok: true, inserted, seen, httpStatus }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const httpStatus = err instanceof SourceError ? err.httpStatus : undefined
    await db.recordPoll({ ok: false, httpStatus, newRows: 0, error: message }, now)
    return { ok: false, inserted: 0, seen: 0, httpStatus, error: message }
  }
}

export interface Poller {
  stop(): void
}

// Polls on a fixed interval; on failure backs off exponentially up to maxBackoffMs.
// Never retries harder than the base interval. This is a .gov upstream on an undocumented route.
export function startPoller(db: ParkingStore, log: (line: string) => void = console.log): Poller {
  let timer: NodeJS.Timeout | undefined
  let backoffMs = 0
  let stopped = false

  const tick = async () => {
    if (stopped) return
    const outcome = await pollOnce(db)
    let delay = config.pollIntervalMs
    if (outcome.ok) {
      backoffMs = 0
      log(`poll ok: ${outcome.inserted} new of ${outcome.seen} lots`)
    } else {
      backoffMs = backoffMs === 0 ? config.pollIntervalMs : Math.min(backoffMs * 2, config.maxBackoffMs)
      delay = backoffMs
      log(`poll failed: ${outcome.error} (next attempt in ${Math.round(delay / 1000)}s)`)
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
