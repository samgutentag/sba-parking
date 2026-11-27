// What the flight board's remark actually says. The Infax feed puts a revised time in the
// remark itself ("Now   9:17A"), on about 4 in 10 flights, so reading it as plain text hides
// delays and early arrivals behind the scheduled time. This turns a stored remark into an
// expected time and a normalized status word.

import { localTimeParts, zonedToUtcMs } from './time.ts'

export type FlightStatus = 'On time' | 'Delayed' | 'Early' | 'Boarding' | 'Departed' | 'Arrived' | 'Canceled'

// Within this many minutes of schedule, a revised time is still "On time".
const ON_TIME_SLACK_MINUTES = 5

const NOW_REMARK = /^now\s+(\d{1,2}):(\d{2})\s*([ap])/i

const PLAIN_REMARKS: Record<string, FlightStatus> = {
  'on time': 'On time',
  boarding: 'Boarding',
  departed: 'Departed',
  arrived: 'Arrived',
  landed: 'Arrived',
  canceled: 'Canceled',
  cancelled: 'Canceled',
}

export interface FlightTiming {
  /** Revised time from a "Now h:mmA" remark, else the scheduled time. Epoch seconds. */
  expectedTs: number
  /** Normalized status, or the remark as published when it's something new. */
  status: FlightStatus | string
}

export function flightTiming(scheduledTs: number, remark: string, timeZone: string): FlightTiming {
  const text = remark.trim().replace(/\s+/g, ' ')
  const plain = PLAIN_REMARKS[text.toLowerCase()]
  if (plain) return { expectedTs: scheduledTs, status: plain }

  const now = NOW_REMARK.exec(text)
  if (!now) return { expectedTs: scheduledTs, status: text }

  const hour12 = Number(now[1]) % 12
  const hour = now[3]!.toLowerCase() === 'p' ? hour12 + 12 : hour12
  const minute = Number(now[2])
  const [year, month, day] = localTimeParts(scheduledTs, timeZone).dateKey.split('-').map(Number) as [number, number, number]
  let expectedTs = Math.floor(zonedToUtcMs({ year, month, day, hour, minute }, timeZone) / 1000)
  // The remark has no date. A late-evening flight pushed past midnight reads as early morning
  // of the same day, and the reverse for an early one, so take whichever day is closest.
  if (expectedTs - scheduledTs < -12 * 3600) expectedTs += 86400
  if (expectedTs - scheduledTs > 12 * 3600) expectedTs -= 86400

  const deltaMinutes = (expectedTs - scheduledTs) / 60
  const status: FlightStatus =
    deltaMinutes >= ON_TIME_SLACK_MINUTES ? 'Delayed' : deltaMinutes <= -ON_TIME_SLACK_MINUTES ? 'Early' : 'On time'
  return { expectedTs, status }
}

/** A confirmed outcome rather than a time that might still change. */
export function isTerminalStatus(status: string): boolean {
  return status === 'Departed' || status === 'Arrived' || status === 'Canceled'
}
