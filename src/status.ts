// Thresholds mirror the airport site's own drupalSettings so labels match theirs.
export type StatusLevel = 'open' | 'busy' | 'limited' | 'full'

export interface Status {
  level: StatusLevel
  label: 'Open' | 'Limited' | 'Full'
  percent: number
}

export function statusFor(total: number, occupied: number): Status {
  const percent = total > 0 ? Math.min(100, Math.round((occupied / total) * 1000) / 10) : 0
  if (percent >= 100) return { level: 'full', label: 'Full', percent }
  if (percent >= 75) return { level: 'limited', label: 'Limited', percent }
  if (percent >= 50) return { level: 'busy', label: 'Open', percent }
  return { level: 'open', label: 'Open', percent }
}
