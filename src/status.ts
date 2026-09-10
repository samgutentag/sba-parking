// Fixed-percent thresholds mirror the airport site's own drupalSettings so labels match
// theirs. They're also the fallback for relativeStatusFor below until a lot has enough history
// to classify against its own typical range.
export type StatusLevel = 'open' | 'busy' | 'limited' | 'full'

export interface Status {
  level: StatusLevel
  label: 'Open' | 'Limited' | 'Full'
  percent: number
  // 'percent': fixed thresholds, matches the airport's own site. 'typical': classified
  // against this lot's own typical-for-this-hour baseline (see relativeStatusFor).
  basis: 'percent' | 'typical'
  typicalPercent?: number
  deviationPp?: number
}

export function statusFor(total: number, occupied: number): Status {
  const percent = total > 0 ? Math.min(100, Math.round((occupied / total) * 1000) / 10) : 0
  if (percent >= 100) return { level: 'full', label: 'Full', percent, basis: 'percent' }
  if (percent >= 75) return { level: 'limited', label: 'Limited', percent, basis: 'percent' }
  if (percent >= 50) return { level: 'busy', label: 'Open', percent, basis: 'percent' }
  return { level: 'open', label: 'Open', percent, basis: 'percent' }
}

export interface RelativeStatusInput {
  total: number
  occupied: number
  /** This lot's typical percent-occupied for the current local hour, or null if unknown. */
  typicalPercent: number | null
  /** Distinct calendar days of history behind that typical curve. */
  days: number
  /** Readiness threshold — same idea as the "same weekday" overlay's gate. */
  minDays: number
}

// A fixed percent-of-capacity band conflates two different lots' definitions of "full": a
// 780-space lot at 75% still has ~190 spaces open, while a 192-space lot at 75% has 48. This
// classifies by how far the current reading deviates from *this lot's own* typical percent for
// this hour instead, so "Limited" means "unusually full for this lot right now," not "crossed
// an arbitrary line that means something different depending on lot size."
//
// Returns null (caller should fall back to statusFor) until there's enough history to trust a
// typical for this hour — comparing against one good day's data would just be circular. 100%+
// is always "Full" regardless: a lot with no more spaces is full no matter what's typical.
//
// Thresholds (25pp deviation, or 92% absolute as a safety net for a lot whose typical itself
// runs hot) are a first pass with no real deviation data behind them yet — expect to retune
// once weeks of history exist to see what a "normal" deviation actually looks like.
export function relativeStatusFor(input: RelativeStatusInput): Status | null {
  const { total, occupied, typicalPercent, days, minDays } = input
  const percent = total > 0 ? Math.min(100, Math.round((occupied / total) * 1000) / 10) : 0
  if (percent >= 100) return { level: 'full', label: 'Full', percent, basis: 'typical', typicalPercent: typicalPercent ?? undefined }
  if (typicalPercent === null || days < minDays) return null

  const deviationPp = Math.round((percent - typicalPercent) * 10) / 10
  if (deviationPp >= 25 || percent >= 92) return { level: 'limited', label: 'Limited', percent, basis: 'typical', typicalPercent, deviationPp }
  if (deviationPp >= 10) return { level: 'busy', label: 'Open', percent, basis: 'typical', typicalPercent, deviationPp }
  return { level: 'open', label: 'Open', percent, basis: 'typical', typicalPercent, deviationPp }
}
