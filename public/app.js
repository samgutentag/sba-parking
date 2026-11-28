'use strict'

// Color follows the lot, never its position in the current result set.
const LOT_SLOT = { '2': 'series-1', '3': 'series-2', '4': 'series-3' }
// Tile display order: Short-term, Long-term, Economy, matching the airport's own site.
const TILE_ORDER = ['3', '4', '2']
const FALLBACK_SLOTS = ['series-4', 'series-5', 'series-6']
// Static reference info, not part of the polled feed. Source: https://flysba.santabarbaraca.gov/airport/parking
// as of 2026-09-09. The airport can change rates without notice; this isn't fetched, so it can drift.
const LOT_INFO = {
  '2': { address: '140 Frederick Lopez Road', price: '$5/hr · $18/day max · cards only · 24/7, shuttle every 15 min' },
  '3': { address: '500 Fowler Road', price: 'Free 0-10 min · $5/hr after · $32/day max · cards & cash' },
  '4': { address: '500 Fowler Road', price: '$5/hr · $23/day max · cards & cash' },
}
// FlightAware's flight-tracker URLs key on the 3-letter ICAO airline code (e.g. "ASA2029"),
// not the 2-letter IATA code the feed gives us (`ac`, e.g. "AS"). Mapped only for carriers
// actually seen serving SBA plus a couple of likely regional ones; an airline missing here
// just renders as plain text instead of a guessed, possibly-wrong link.
const AIRLINE_ICAO = {
  AS: 'ASA', // Alaska
  AA: 'AAL', // American
  DL: 'DAL', // Delta
  UA: 'UAL', // United
  WN: 'SWA', // Southwest
  XP: 'VXP', // Avelo
  G4: 'AAY', // Allegiant
}
function flightAwareUrl(airlineCode, flightNumber) {
  const icao = AIRLINE_ICAO[airlineCode]
  return icao ? `https://www.flightaware.com/live/flight/${icao}${flightNumber}` : null
}

// `terminal` comes from the server (departed, arrived, canceled: a confirmed outcome, not a
// guess). Once one of these is 30+ minutes past its expected time, the flight board drops it
// rather than let the board grow indefinitely with flights nobody needs to see anymore.
const FLIGHT_BOARD_COMPLETED_AFTER_MS = 30 * 60_000
function isFlightDoneAndOld(f) {
  if (!f.terminal) return false
  return Date.now() - Date.parse(f.expectedAt) > FLIGHT_BOARD_COMPLETED_AFTER_MS
}

// Status words that get a color on the board; everything else renders plain.
const FLIGHT_STATUS_CLASS = { Delayed: 'status-delayed', Early: 'status-early', Canceled: 'status-canceled' }

// Who a gap in the readings is on, as the server works it out from its own poll log.
const GAP_LABEL = {
  paused: 'Airport feed paused',
  unreachable: 'Airport site unreachable',
  offline: 'Tracker offline',
}
const GAP_SHORT_LABEL = { paused: 'Paused', unreachable: 'Unreachable', offline: 'Offline' }

function gapSpanText(gap) {
  const from = new Date(gap.fromAt)
  const to = new Date(gap.toAt)
  const hours = (to - from) / 3_600_000
  const len = hours < 48 ? `${hours < 10 ? hours.toFixed(1) : Math.round(hours)} h` : `${Math.round(hours / 24)} d`
  const sameDay = fmt.date.format(from) === fmt.date.format(to)
  const f = (d) => (sameDay ? fmt.time : fmt.dateTime).format(d)
  return gap.ongoing ? `since ${f(from)} (${len})` : `${f(from)} – ${f(to)} (${len})`
}

const STATUS = {
  open: { token: '--status-good', glyph: '✓' },
  busy: { token: '--status-warning', glyph: '◐' },
  limited: { token: '--status-serious', glyph: '▲' },
  full: { token: '--status-critical', glyph: '■' },
}
const REFRESH_MS = 60_000
// Trend badge: how far back to compare, how big a change has to be before it's worth showing.
// Shared 15-min-bucket fetch for two things: the trend badge (needs the last ~30 min) and the
// tiles' day strips (today since midnight, at most 24 h). One fetch covers both.
const MINI_HISTORY_RANGE = '24h'
const TREND_WINDOW_MS = 30 * 60_000
const TREND_THRESHOLD_PP = 5
const TREND = {
  tightening: { glyph: '↑', label: 'tightening' },
  opening: { glyph: '↓', label: 'opening up' },
  steady: { glyph: '→', label: 'steady' },
}

const state = {
  range: 'today',
  timeZone: 'America/Los_Angeles',
  latest: null,
  mini: null, // last 24h at 15-min buckets, for the tiles' trend badges and day strips
  history: null,
  typical: null,
  showTypicalDay: false,
  showTypicalDow: false,
  flights: null,
  showArrivals: false,
  showDepartures: false,
  hoverIndex: null,
}

// Baseline overlays repeat a 24h curve across the visible window, which only reads as a
// reference line on short ranges; over 30d/all it would just be a weekly sawtooth under
// months of real data, so the toggle hides itself there instead of rendering noise.
const TYPICAL_SUPPORTED_RANGES = new Set(['6h', 'today', '7d'])
const TYPICAL_REFRESH_MS = 30 * 60_000 // baselines drift slowly; no need for the 60s cadence
// Flight markers are one vertical line per scheduled flight. Even a single day is ~20 flights,
// so anything wider than a day (7d and up) would just be a wall of lines — restrict to the
// two short, single-day-ish ranges where the lines stay legible.
const FLIGHTS_SUPPORTED_RANGES = new Set(['6h', 'today'])
// Turned off for now: even scoped to short ranges, the vertical lines read as cluttered.
// Flip this back on to re-enable the toggle and overlay — the rest of the code is untouched.
const FLIGHTS_CHART_MARKERS_ENABLED = false

const $ = (id) => document.getElementById(id)
const els = {
  sourceLine: $('source-line'), sourceLineMobile: $('source-line-mobile'), tiles: $('tiles'), legend: $('legend'), chart: $('chart'),
  chartWrap: $('chart-wrap'), chartEmpty: $('chart-empty'), tooltip: $('tooltip'),
  historyLine: $('history-line'), trackerStatusBody: $('tracker-status-body'), trackerStatusSummary: $('tracker-status-summary'), chartStatus: $('chart-status'), typicalGroup: $('typical-group'),
  flightsGroup: $('flights-group'),
  flightsBoardSub: $('flights-board-sub'),
  arrivalsTable: $('arrivals-table'), arrivalsEmpty: $('arrivals-empty'), arrivalsHeading: $('arrivals-heading'),
  departuresTable: $('departures-table'), departuresEmpty: $('departures-empty'), departuresHeading: $('departures-heading'),
}

function lotColorVar(lotId, index) {
  const slot = LOT_SLOT[lotId] ?? FALLBACK_SLOTS[Math.min(index, FALLBACK_SLOTS.length - 1)]
  return `var(--${slot})`
}
function shortName(name) {
  return name.replace(/\s*parking\s*$/i, '')
}
function pct(occupied, total) {
  return total > 0 ? Math.min(100, (occupied / total) * 100) : 0
}
// The main chart plots availability, not occupancy: higher on the chart should read as "more
// parking available," which means the line needs percent-free, not percent-occupied. Status
// labels, the meter fill, and trend badges still key off occupied percent (thresholds are
// defined that way), so this conversion is applied wherever the wording needs to flip, not
// baked into the underlying value. The tile detail line (below) is one such wording flip.
function avail(occupiedPct) {
  return 100 - occupiedPct
}
function levelFor(percent) {
  if (percent >= 100) return 'full'
  if (percent >= 75) return 'limited'
  if (percent >= 50) return 'busy'
  return 'open'
}

// Explains which of the two classifiers is behind the status chip. Once a lot has enough
// history, /api/latest switches from a fixed percent-of-capacity band (same for every lot
// regardless of size) to comparing against that lot's own typical occupancy for this hour —
// see relativeStatusFor in src/status.ts for why. Surfaced as a tooltip rather than new UI so
// the tile layout doesn't change the moment a lot crosses the data threshold.
function statusChipTitle(lot) {
  if (lot.statusBasis !== 'typical' || lot.typicalPercent === null) {
    return "Matches the airport's own percent-of-capacity thresholds."
  }
  if (lot.deviationPp === null) return `Typically ${Math.round(lot.typicalPercent)}% full at this hour.`
  const dir = lot.deviationPp >= 0 ? 'busier' : 'quieter'
  return `${Math.abs(Math.round(lot.deviationPp))} points ${dir} than typical for this hour (typically ${Math.round(lot.typicalPercent)}% full).`
}

// Compares current percent-occupied to the reading closest to `windowMs` before `nowMs`.
// Returns null when there's no reading near enough to that target to trust the comparison
// (for example, right after the poller starts and history is still thin).
function trendFor(currentPercent, points, windowMs, nowMs) {
  if (!points.length) return null
  const targetMs = nowMs - windowMs
  let best = null
  for (const [ts, occ, tot] of points) {
    const ms = ts * 1000
    const dist = Math.abs(ms - targetMs)
    if (!best || dist < best.dist) best = { dist, p: pct(occ, tot) }
  }
  if (!best || best.dist > windowMs * 0.5) return null
  const delta = currentPercent - best.p
  if (Math.abs(delta) < TREND_THRESHOLD_PP) return { key: 'steady', delta }
  return { key: delta > 0 ? 'tightening' : 'opening', delta }
}

// Time formatting, always in the airport's zone.
const fmt = {
  time: new Intl.DateTimeFormat('en-US', { timeZone: state.timeZone, hour: 'numeric', minute: '2-digit' }),
  hourOnly: new Intl.DateTimeFormat('en-US', { timeZone: state.timeZone, hour: 'numeric' }),
  dayTime: new Intl.DateTimeFormat('en-US', { timeZone: state.timeZone, weekday: 'short', hour: 'numeric', minute: '2-digit' }),
  date: new Intl.DateTimeFormat('en-US', { timeZone: state.timeZone, month: 'short', day: 'numeric' }),
  dateTime: new Intl.DateTimeFormat('en-US', { timeZone: state.timeZone, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }),
  full: new Intl.DateTimeFormat('en-US', { timeZone: state.timeZone, month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }),
  parts: new Intl.DateTimeFormat('en-US', { timeZone: state.timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }),
}
function zoneOffsetMs(utcMs) {
  const p = Object.fromEntries(fmt.parts.formatToParts(new Date(utcMs)).map((x) => [x.type, x.value]))
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second)
  return asUtc - Math.floor(utcMs / 1000) * 1000
}
// Local midnight (in the airport's zone) on or after the given instant.
function nextLocalMidnight(utcMs) {
  const p = Object.fromEntries(fmt.parts.formatToParts(new Date(utcMs)).map((x) => [x.type, x.value]))
  let guess = Date.UTC(+p.year, +p.month - 1, +p.day)
  guess -= zoneOffsetMs(guess)
  if (guess < utcMs) {
    guess = Date.UTC(+p.year, +p.month - 1, +p.day + 1)
    guess -= zoneOffsetMs(guess)
  }
  return guess
}
const weekdayFmt = new Intl.DateTimeFormat('en-US', { timeZone: state.timeZone, weekday: 'short' })
const WEEKDAY_INDEX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }
function localWeekday(utcMs) {
  return WEEKDAY_INDEX[weekdayFmt.format(new Date(utcMs))] ?? 0
}

function relative(iso) {
  if (!iso) return 'never'
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000))
  if (s < 60) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  if (h < 48) return `${h} h ago`
  return `${Math.round(h / 24)} d ago`
}

// A fresh reading reads best as an age ("updated 4 min ago"). Past the same 30-minute line where
// a reading counts as stale, an age hides when it actually was ("9 h ago" on a morning visit
// doesn't say "last night"), so switch to the clock time, with the day once it isn't today.
const AS_OF_RELATIVE_MS = 30 * 60_000
const dayKeyFmt = new Intl.DateTimeFormat('en-CA', { timeZone: state.timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
function asOf(iso) {
  const ms = Date.parse(iso)
  const ageMs = Date.now() - ms
  if (ageMs < AS_OF_RELATIVE_MS) return `updated ${relative(iso)}`
  const d = new Date(ms)
  if (dayKeyFmt.format(d) === dayKeyFmt.format(new Date())) return `as of ${fmt.time.format(d)}`
  return `as of ${(ageMs < 6 * 86400_000 ? fmt.dayTime : fmt.dateTime).format(d)}`
}

async function getJson(url) {
  const res = await fetch(url, { cache: 'no-store' })
  if (!res.ok) {
    // Prefer the server's own explanation when it sends one.
    const detail = await res.json().then((b) => b?.error, () => null)
    throw new Error(detail || `${url} -> HTTP ${res.status}`)
  }
  return res.json()
}

// ---- Tiles -------------------------------------------------------------------

const USUAL_WORD = { open: 'Open', busy: 'Open', limited: 'Limited', full: 'Full' }

// `when` null shows live counts; otherwise each tile shows that lot's usual numbers for the
// picked day and hour (see currentWhen), styled so it can't be mistaken for a live reading.
function renderTiles(latest, trend, when = null) {
  hideBarTooltip() // a full re-render replaces the bars a stuck tooltip might be pointing at
  els.tiles.replaceChildren()
  if (!latest.lots.length) {
    const p = document.createElement('p')
    p.className = 'empty'
    p.textContent = 'No readings yet. First poll is in progress.'
    els.tiles.append(p)
    return
  }
  const nowMs = Date.now()
  const orderedLots = [...latest.lots].sort((a, b) => TILE_ORDER.indexOf(a.lotId) - TILE_ORDER.indexOf(b.lotId))
  orderedLots.forEach((lot, i) => {
    const typicalLot = when ? typicalLotFor(lot.lotId) : null
    const usualPercent = typicalLot ? usualCurve(typicalLot, when.weekday).hours[when.hour] ?? null : null
    const percent = when ? usualPercent : lot.percent
    const level = when ? (percent === null ? null : levelFor(percent)) : lot.level ?? levelFor(lot.percent)
    const status = level ? STATUS[level] : null
    const free = when ? (percent === null ? null : Math.max(0, Math.round(lot.total * (1 - percent / 100)))) : lot.free
    const tile = document.createElement('article')
    // A stale reading still shows its numbers (they're the last real ones), but the status
    // chip stops claiming "Open"/"Limited" about right now and the trend is dropped, since
    // neither means anything once the feed has stopped moving.
    const stale = !when && lot.stale === true
    tile.className = when ? 'tile tile-usual' : stale ? 'tile tile-stale' : 'tile'
    tile.dataset.lotId = lot.lotId
    tile.style.setProperty('--lot-color', lotColorVar(lot.lotId, i))
    tile.style.setProperty('--chip-color', stale || !status ? 'var(--muted)' : `var(${status.token})`)
    tile.addEventListener('pointerenter', () => setLotHover(lot.lotId))
    tile.addEventListener('pointerleave', () => setLotHover(null))

    const label = document.createElement('div')
    label.className = 'label'
    const name = document.createElement('span')
    name.textContent = lot.lotName
    label.append(name)
    if (!stale && status) {
      const chip = document.createElement('span')
      chip.className = 'chip'
      chip.title = when ? `How full this lot usually is ${when.label.toLowerCase()}.` : statusChipTitle(lot)
      const glyph = document.createElement('span')
      glyph.className = 'glyph'
      glyph.setAttribute('aria-hidden', 'true')
      glyph.textContent = status.glyph
      chip.append(glyph, document.createTextNode(when ? `Usually ${USUAL_WORD[level].toLowerCase()}` : lot.status))
      label.append(chip)
    }

    const trendLotHist = trend?.lots.find((l) => l.lotId === lot.lotId)
    const t = trendLotHist && !when
      ? trendFor(lot.percent, trendLotHist.points, TREND_WINDOW_MS, Date.parse(lot.sourceUpdatedAt))
      : null

    // Middle row: ring | free-of-total count | trend.
    const mid = document.createElement('div')
    mid.className = 'tile-mid'

    const ringCol = document.createElement('div')
    ringCol.className = 'tile-ring'
    ringCol.append(ringChart(percent ?? 0, 'var(--chip-color)'))

    const valueCol = document.createElement('div')
    valueCol.className = 'tile-value'
    const valueMain = document.createElement('span')
    valueMain.className = 'value-main'
    valueMain.textContent = free === null ? '–' : `${when ? '~' : ''}${free.toLocaleString()}`
    const small = document.createElement('small')
    small.textContent = free === null
      ? 'no history for this hour yet'
      : `${when ? 'usually open' : 'open spots'} of ${lot.total.toLocaleString()}`
    valueMain.append(small)
    valueCol.append(valueMain)

    mid.append(ringCol, valueCol)

    if (t && !stale) {
      const info = TREND[t.key]
      const badge = document.createElement('span')
      badge.className = `trend trend-${t.key}`
      const badgeGlyph = document.createElement('span')
      badgeGlyph.setAttribute('aria-hidden', 'true')
      badgeGlyph.textContent = info.glyph
      badge.append(badgeGlyph, document.createTextNode(info.label))
      badge.setAttribute(
        'aria-label',
        t.key === 'steady'
          ? 'Occupancy steady over the last 30 minutes'
          : `Occupancy ${info.label}, ${Math.abs(Math.round(t.delta))} percentage points over the last 30 minutes`,
      )
      const trendCol = document.createElement('div')
      trendCol.className = 'tile-trend'
      trendCol.append(badge)
      mid.append(trendCol)
    }

    const meter = document.createElement('div')
    meter.className = 'meter'
    meter.setAttribute('role', 'meter')
    meter.setAttribute('aria-valuemin', '0')
    meter.setAttribute('aria-valuemax', '100')
    meter.setAttribute('aria-valuenow', String(Math.round(percent ?? 0)))
    meter.setAttribute('aria-label', `${lot.lotName} ${when ? 'usual ' : ''}occupancy`)
    const fill = document.createElement('span')
    fill.style.width = `${Math.min(100, percent ?? 0)}%`
    meter.append(fill)

    const strip = dayStripEl(lot, trendLotHist, when, nowMs)

    const detail = document.createElement('div')
    detail.className = 'detail'
    const left = document.createElement('span')
    const right = document.createElement('span')
    if (when) {
      left.textContent = percent === null ? '' : `usually ${Math.round(avail(percent))}% available`
      right.textContent = when.label
    } else {
      left.textContent = `${Math.round(avail(lot.percent))}% available · ${lot.free.toLocaleString()} open`
      right.textContent = asOf(lot.sourceUpdatedAt)
    }
    detail.append(left, right)

    tile.append(label)
    if (stale) tile.append(staleNoteEl(latest.feed?.cause, lot.sourceUpdatedAt))
    tile.append(mid, meter, strip, detail)

    const vsUsual = when ? null : vsUsualText(lot)
    if (vsUsual) {
      const vs = document.createElement('p')
      vs.className = 'vs-usual'
      vs.textContent = vsUsual
      tile.append(vs)
    }

    const info = LOT_INFO[lot.lotId]
    if (info) {
      const infoEl = document.createElement('p')
      infoEl.className = 'info'
      const address = document.createElement('span')
      address.textContent = info.address
      const price = document.createElement('span')
      price.textContent = info.price
      infoEl.append(address, price)
      tile.append(infoEl)
    }

    els.tiles.append(tile)
  })
}

// Small donut: background track + one colored arc for percent occupied, percent centered.
// Ring shows percent AVAILABLE, not occupied — same "spots available, not parked cars" framing
// as the main chart and the count next to it. The arc's color still comes from the status chip
// (occupancy-based thresholds), so a mostly-full ring under a red "Limited" chip still reads as
// concerning even though the ring itself is measuring the opposite quantity.
// Says whose side the missing data is on, so "the airport stopped publishing" never reads
// the same as "this site stopped collecting." Same causes as the chart's outage bands.
const STALE_NOTE = {
  paused: { glyph: '⏸', title: "Airport isn't publishing updates", body: (t) => `No new counts from the airport since ${t}. These are its last numbers.` },
  unreachable: { glyph: '⚠', title: "Airport's site isn't responding", body: (t) => `Couldn't reach the airport's feed since ${t}. These are the last numbers it gave.` },
  offline: { glyph: '⚠', title: 'This tracker is offline', body: (t) => `This site stopped collecting at ${t}. These are the last numbers it saved.` },
}

function staleNoteEl(cause, sinceIso) {
  const note = STALE_NOTE[cause] ?? STALE_NOTE.paused
  const el = document.createElement('div')
  el.className = `stale-note stale-${cause ?? 'paused'}`
  el.setAttribute('role', 'status')
  const glyph = document.createElement('span')
  glyph.className = 'glyph'
  glyph.setAttribute('aria-hidden', 'true')
  glyph.textContent = note.glyph
  const text = document.createElement('div')
  const strong = document.createElement('strong')
  strong.textContent = note.title
  const body = document.createElement('span')
  body.textContent = note.body(fmt.time.format(new Date(sinceIso)))
  text.append(strong, body)
  el.append(glyph, text)
  return el
}

function ringChart(occupiedPercent, colorVar) {
  const size = 64
  const stroke = 8
  const r = (size - stroke) / 2
  const c = 2 * Math.PI * r
  const pctVal = Math.max(0, Math.min(100, avail(occupiedPercent)))
  const dash = (pctVal / 100) * c
  const svg = svgEl('svg', {
    viewBox: `0 0 ${size} ${size}`, width: size, height: size, class: 'ring',
    role: 'img', 'aria-label': `${Math.round(pctVal)}% available`,
  })
  svg.append(svgEl('circle', { cx: size / 2, cy: size / 2, r, class: 'ring-track' }))
  svg.append(svgEl('circle', {
    cx: size / 2, cy: size / 2, r, class: 'ring-value', stroke: colorVar,
    'stroke-dasharray': `${dash.toFixed(1)} ${(c - dash).toFixed(1)}`,
    transform: `rotate(-90 ${size / 2} ${size / 2})`,
  }))
  const label = svgEl('text', { x: size / 2, y: size / 2 + 5, 'text-anchor': 'middle', class: 'ring-label' })
  label.textContent = `${Math.round(pctVal)}%`
  svg.append(label)
  return svg
}

// 24 hourly buckets of average free spaces over the trailing 24h, oldest first (left),
// most recent hour last (right). A bucket with no readings yet renders as a near-empty bar
// rather than being skipped, so the chart always shows 24 slots even while data is thin.
// `ms` is that bucket's approximate clock hour, kept for the hover tooltip's hour label.
// A single shared flag-shaped tooltip for every hour bar on the page, positioned per-hover
// rather than one tooltip element per bar. Custom rather than a native `title` attribute for
// three things a title tooltip can't do: a pointed flag shape, centered multi-line text, and
// showing instantly instead of after the browser's built-in hover delay.
let barTooltipEl = null
function getBarTooltip() {
  if (!barTooltipEl) {
    barTooltipEl = document.createElement('div')
    barTooltipEl.className = 'bar-tooltip'
    barTooltipEl.hidden = true
    document.body.append(barTooltipEl)
  }
  return barTooltipEl
}

function positionBarTooltip(barEl) {
  const tip = getBarTooltip()
  const rect = barEl.getBoundingClientRect()
  tip.style.left = `${rect.left + rect.width / 2}px`
  tip.style.top = `${rect.top - 8}px`
}

function showBarTooltip(barEl, hourLabel, valueLabel) {
  const tip = getBarTooltip()
  const hourEl = document.createElement('div')
  hourEl.className = 'bt-hour'
  hourEl.textContent = hourLabel
  const valueEl = document.createElement('div')
  valueEl.className = 'bt-value'
  valueEl.textContent = valueLabel
  tip.replaceChildren(hourEl, valueEl)
  tip.hidden = false
  positionBarTooltip(barEl)
}

function hideBarTooltip() {
  if (barTooltipEl) barTooltipEl.hidden = true
}

// ---- When: now, or a typical day and hour ---------------------------------------
// The tiles show live counts by default. Picking a day and hour switches them to that lot's
// usual numbers for then, from the same baselines as the chart's dashed lines: that weekday's
// curve once it has enough days behind it, else the all-days curve. Only "usually" numbers;
// how far today is running from usual is shown beside them, never folded into a projection.
const WHEN_DAYS = 7
const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const whenDayFmt = new Intl.DateTimeFormat('en-US', { timeZone: state.timeZone, weekday: 'short', month: 'short', day: 'numeric' })
const whenEls = { wrap: $('when'), day: $('when-day'), hourLabel: $('when-hour-label'), hour: $('when-hour'), note: $('when-note'), bestBet: $('best-bet') }

function hourLabel(hour) {
  return `${hour % 12 || 12} ${hour < 12 ? 'am' : 'pm'}`
}
function localHour(utcMs) {
  return Number(fmt.parts.formatToParts(new Date(utcMs)).find((x) => x.type === 'hour').value)
}
// An instant inside each of the next WHEN_DAYS local days: now for today, noon after that.
function whenDayInstants(nowMs) {
  const tomorrow = nextLocalMidnight(nowMs + 1)
  return Array.from({ length: WHEN_DAYS }, (_, i) => (i === 0 ? nowMs : tomorrow + (i - 1) * 86400_000 + 12 * 3600_000))
}
function usualCurve(typicalLot, weekday) {
  const minDays = state.typical?.minDaysForDayOfWeek ?? 3
  const dow = typicalLot.dayOfWeek.find((d) => d.weekday === weekday)
  if (isDowCurveReady(dow, minDays)) return { hours: dow.hours, sameWeekday: true, days: dow.days }
  return { hours: typicalLot.day.hours, sameWeekday: false, days: typicalLot.days }
}
function typicalLotFor(lotId) {
  return state.typical?.lots.find((l) => l.lotId === lotId) ?? null
}
// null means "now"; otherwise { dayIndex, hour, weekday, label }.
function currentWhen() {
  if (whenEls.day.value === 'now' || !state.typical) return null
  const dayIndex = Number(whenEls.day.value)
  const hour = Number(whenEls.hour.value)
  const instant = whenDayInstants(Date.now())[dayIndex]
  const day = dayIndex === 0 ? 'Today' : dayIndex === 1 ? 'Tomorrow' : weekdayFmt.format(new Date(instant))
  return { dayIndex, hour, weekday: localWeekday(instant), label: `${day} at ${hourLabel(hour)}` }
}

function initWhen() {
  for (let h = 0; h < 24; h++) whenEls.hour.append(new Option(hourLabel(h), String(h)))
  fillWhenDays(Date.now(), 'now')
  whenEls.day.addEventListener('change', () => {
    // Default a newly picked day to the next whole hour: the soonest anyone could pull in.
    if (whenEls.day.value !== 'now' && whenEls.hourLabel.hidden) whenEls.hour.value = String((localHour(Date.now()) + 1) % 24)
    rerenderTiles()
  })
  whenEls.hour.addEventListener('change', rerenderTiles)
}
// Rebuilt on each render so "Today" moves at midnight on a page left open.
function fillWhenDays(nowMs, selected) {
  const options = [new Option('Now', 'now')]
  whenDayInstants(nowMs).forEach((ms, i) => {
    const date = whenDayFmt.format(new Date(ms))
    options.push(new Option(i === 0 ? `Later today, ${date}` : i === 1 ? `Tomorrow, ${date}` : date, String(i)))
  })
  whenEls.day.replaceChildren(...options)
  whenEls.day.value = selected
}
function setWhen(dayValue, hour) {
  whenEls.day.value = dayValue
  whenEls.hour.value = String(hour)
  rerenderTiles()
}

function rerenderTiles() {
  if (!state.latest) return
  const hasTypical = !!state.typical?.lots.some((l) => l.day.hours.some((v) => v !== null))
  whenEls.wrap.hidden = !hasTypical
  fillWhenDays(Date.now(), hasTypical ? whenEls.day.value || 'now' : 'now')
  const when = currentWhen()
  whenEls.hourLabel.hidden = !when
  renderTiles(state.latest, state.mini, when)
  renderBestBet(state.latest, when)
  renderWhenNote(when)
}

function renderWhenNote(when) {
  whenEls.note.hidden = !when
  if (!when) return
  const curves = state.typical.lots.map((l) => usualCurve(l, when.weekday))
  const name = WEEKDAY_NAMES[when.weekday]
  const sameWeekday = curves.filter((c) => c.sameWeekday)
  const basis = sameWeekday.length === curves.length
    ? `Usual numbers, averaged over the last ${Math.min(...sameWeekday.map((c) => c.days))} ${name}s.`
    : `Usual numbers. Not enough ${name}s recorded yet${sameWeekday.length ? ' for every lot' : ''}, so ${sameWeekday.length ? 'some lots use' : 'this uses'} every day of the week.`
  whenEls.note.textContent = `${basis} Holidays and big events can run well above usual; pick Now for live counts.`
}

// One plain sentence answering "where should I park?": the lot with the most open spots, and
// any lot that's nearly full. Counts only; it doesn't weigh price or the shuttle ride.
function renderBestBet(latest, when) {
  const rows = latest.lots
    .map((lot) => {
      if (!when) return lot.stale ? null : { name: shortName(lot.lotName), open: lot.free, percent: lot.percent }
      const t = typicalLotFor(lot.lotId)
      const p = t ? usualCurve(t, when.weekday).hours[when.hour] : null
      return p === null || p === undefined ? null : { name: shortName(lot.lotName), open: Math.max(0, Math.round(lot.total * (1 - p / 100))), percent: p }
    })
    .filter(Boolean)
  if (!rows.length) {
    whenEls.bestBet.textContent = when ? `No history for ${when.label.toLowerCase()} yet.` : 'No fresh counts from the airport right now. The tiles show its last numbers.'
    return
  }
  const usually = when ? 'usually ' : ''
  const best = rows.reduce((a, b) => (b.open > a.open ? b : a))
  const prefix = when ? `${when.label}: ` : ''
  let text = `${prefix}${best.name} ${usually}has the most room, ${when ? '~' : ''}${best.open.toLocaleString()} open${when ? '' : ' right now'}.`
  const tight = rows.filter((r) => r !== best && r.percent >= 90)
  if (tight.length) {
    const names = tight.map((r) => r.name).join(' and ')
    const verb = tight.length > 1 ? 'are' : 'is'
    text += ` ${names} ${verb} ${usually}${tight.every((r) => r.percent >= 100) ? 'full' : 'nearly full'}.`
  }
  whenEls.bestBet.textContent = text
}

// The tile's 24-hour strip, midnight to midnight. Live mode: earlier hours are what actually
// happened today, later hours are what's usual for today's weekday (drawn faint), so one strip
// shows both the day so far and what's coming. Picked-time mode: the usual curve for that day,
// with the picked hour highlighted. Bars that show a usual hour can be tapped to pick it.
function dayStripEl(lot, history, when, nowMs) {
  const typicalLot = typicalLotFor(lot.lotId)
  const total = lot.total
  const openFor = (p) => (p === null || p === undefined ? null : Math.max(0, Math.round(total * (1 - p / 100))))
  const bars = []
  if (when) {
    const curve = typicalLot ? usualCurve(typicalLot, when.weekday).hours : Array(24).fill(null)
    for (let h = 0; h < 24; h++) bars.push({ h, value: openFor(curve[h]), kind: 'usual', picked: h === when.hour })
  } else {
    const todayStart = nextLocalMidnight(nowMs - 86400_000 + 1)
    const nowHour = localHour(nowMs)
    const sums = Array.from({ length: 24 }, () => ({ sum: 0, n: 0 }))
    for (const [ts, occ, tot] of history?.points ?? []) {
      const ms = ts * 1000
      if (ms < todayStart || ms > nowMs) continue
      const s = sums[localHour(ms)]
      s.sum += Math.max(0, tot - occ)
      s.n += 1
    }
    const curve = typicalLot ? usualCurve(typicalLot, localWeekday(nowMs)).hours : Array(24).fill(null)
    for (let h = 0; h < 24; h++) {
      if (h <= nowHour) {
        const s = sums[h]
        bars.push({ h, value: s.n ? Math.round(s.sum / s.n) : null, kind: 'actual', now: h === nowHour })
      } else {
        bars.push({ h, value: openFor(curve[h]), kind: 'usual' })
      }
    }
  }

  const wrap = document.createElement('div')
  wrap.className = 'hour-bars day-strip'
  wrap.setAttribute('role', 'group')
  wrap.setAttribute('aria-label', when
    ? `${shortName(lot.lotName)}: usual open spots by hour, ${when.label.replace(/ at .*/, '')}`
    : `${shortName(lot.lotName)}: open spots by hour today, actual so far and usual for later hours`)
  const max = Math.max(1, ...bars.map((b) => b.value).filter((v) => v !== null))
  for (const b of bars) {
    const pickable = b.kind === 'usual' && b.value !== null
    const bar = document.createElement(pickable ? 'button' : 'span')
    if (pickable) bar.type = 'button'
    bar.className = `bar bar-${b.kind}${b.value === null ? ' bar-empty' : ''}${b.now ? ' bar-now' : ''}${b.picked ? ' bar-picked' : ''}`
    bar.style.height = b.value === null ? '4%' : `${Math.max(6, (b.value / max) * 100)}%`
    const valueText = b.value === null ? 'no data' : b.kind === 'usual' ? `usually ~${b.value} open` : `${b.value} open${b.now ? ' so far' : ''}`
    if (pickable) {
      bar.setAttribute('aria-label', `${hourLabel(b.h)}: ${valueText}`)
      if (b.picked) bar.setAttribute('aria-pressed', 'true')
      bar.addEventListener('click', () => setWhen(when ? String(when.dayIndex) : '0', b.h))
    }
    if (b.value !== null) {
      bar.addEventListener('pointerenter', () => showBarTooltip(bar, hourLabel(b.h), valueText))
      bar.addEventListener('pointerleave', hideBarTooltip)
    }
    wrap.append(bar)
  }
  const axis = document.createElement('div')
  axis.className = 'strip-axis'
  axis.setAttribute('aria-hidden', 'true')
  for (const t of ['12 am', '6 am', 'noon', '6 pm', '11 pm']) axis.append(Object.assign(document.createElement('span'), { textContent: t }))
  const el = document.createElement('div')
  el.append(wrap, axis)
  return el
}

// How far a live lot is running from its usual for this hour, in plain words. Null when there's
// no baseline for this hour or the reading is stale.
function vsUsualText(lot) {
  const t = typicalLotFor(lot.lotId)
  if (!t || lot.stale) return null
  const usual = usualCurve(t, localWeekday(Date.now())).hours[localHour(Date.parse(lot.sourceUpdatedAt))]
  if (usual === null || usual === undefined) return null
  const dev = Math.round(lot.percent - usual)
  if (Math.abs(dev) < 5) return 'About as full as usual for this hour.'
  return `${Math.abs(dev)} points ${dev > 0 ? 'fuller' : 'emptier'} than usual for this hour.`
}

// Tracker status, in the footer: each poller's last result, verbatim error included. Kept out
// of the header so an outage reads as one quiet line up top, with the detail here for whoever
// wants it. Each poller fills its own row as its data loads.
const trackerPollers = {}
function renderTrackerStatus(key, label, p) {
  trackerPollers[key] = { label, p }
  const rows = Object.values(trackerPollers).map(({ label, p }) => {
    const row = document.createElement('p')
    if (!p.enabled) {
      row.textContent = `${label}: polling disabled on this instance.`
      return row
    }
    const outcome = p.lastPollOk === false ? 'failed' : 'ok'
    row.textContent = `${label}: last poll ${p.lastPollAt ? relative(p.lastPollAt) : 'never'} (${outcome}), every ${Math.round(p.intervalMs / 60_000)} min, ${p.failedLast24h} failed in the last 24 h.`
    if (p.lastPollOk === false && p.lastError) {
      const err = document.createElement('code')
      err.className = 'tracker-error'
      err.textContent = p.lastError
      row.append(document.createElement('br'), err)
    }
    return row
  })
  els.trackerStatusBody.replaceChildren(...rows)
  const failing = Object.values(trackerPollers).some(({ p }) => p.enabled && p.lastPollOk === false)
  els.trackerStatusSummary.textContent = failing ? 'Tracker status: a poll is failing' : 'Tracker status'
}

function renderSourceLine(latest) {
  const p = latest.poller
  const dot = document.createElement('span')
  dot.className = 'dot'
  let text
  if (!p.enabled) {
    dot.classList.add('stale')
    text = 'Polling disabled on this instance.'
  } else if (!p.lastPollAt) {
    dot.classList.add('stale')
    text = 'Waiting for first poll…'
  } else {
    const ageMs = Date.now() - Date.parse(p.lastPollAt)
    if (p.lastPollOk === false) dot.classList.add('bad')
    else if (ageMs > p.intervalMs * 3) dot.classList.add('stale')
    text = `Last poll ${relative(p.lastPollAt)}`
    // The raw error belongs in Tracker status at the bottom, not in the page's headline.
    if (p.lastPollOk === false) text += ' failed · details under Tracker status below'
    else if (latest.feed?.stale && latest.lots[0]) {
      dot.classList.add('stale')
      text += ` · ${latest.feed.cause === 'paused' ? 'airport feed paused' : 'no new data'} since ${fmt.time.format(new Date(latest.lots[0].sourceUpdatedAt))} PT`
    } else if (latest.lots[0]) text += ` · feed ${asOf(latest.lots[0].sourceUpdatedAt)}`
  }
  // Rendered twice: once for the header (desktop) and once below the tiles (mobile) — see
  // .source-line-mobile in style.css. Two elements rather than one repositioned via CSS,
  // since the header and the tiles section aren't siblings in a layout that `order` could
  // reorder across.
  els.sourceLine.replaceChildren(dot, document.createTextNode(text))
  els.sourceLineMobile.replaceChildren(dot.cloneNode(true), document.createTextNode(text))

  renderTrackerStatus('parking', 'Parking', p)

  const h = latest.history
  els.historyLine.textContent = h.readings
    ? `${h.readings.toLocaleString()} readings stored since ${fmt.full.format(new Date(h.earliestAt))}.`
    : 'No readings stored yet.'
}

// ---- Chart -------------------------------------------------------------------

const SVG_NS = 'http://www.w3.org/2000/svg'
function svgEl(tag, attrs = {}) {
  const el = document.createElementNS(SVG_NS, tag)
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v))
  return el
}

// Catmull-Rom through the real points, converted to cubic Bezier segments. No interpolated
// values, just a smoother line through the same readings a straight-segment path would use.
function smoothPath(pts) {
  if (pts.length === 0) return ''
  if (pts.length === 1) return `M${pts[0].x.toFixed(1)},${pts[0].y.toFixed(1)}`
  let d = `M${pts[0].x.toFixed(1)},${pts[0].y.toFixed(1)}`
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i]
    const p1 = pts[i]
    const p2 = pts[i + 1]
    const p3 = pts[i + 2] ?? p2
    const c1x = p1.x + (p2.x - p0.x) / 6
    const c1y = p1.y + (p2.y - p0.y) / 6
    const c2x = p2.x - (p3.x - p1.x) / 6
    const c2y = p2.y - (p3.y - p1.y) / 6
    d += `C${c1x.toFixed(1)},${c1y.toFixed(1)} ${c2x.toFixed(1)},${c2y.toFixed(1)} ${p2.x.toFixed(1)},${p2.y.toFixed(1)}`
  }
  return d
}

// Repeats a 24h typical curve across every local calendar day the visible window touches.
// `kind` picks which curve backs each day: 'day' uses the one blended-across-all-days curve,
// 'dow' looks up that day's own weekday so a Tuesday shows Tuesday's average, a Saturday
// shows Saturday's. Hours with no historical reading (null) are skipped rather than
// interpolated, so the dashed line breaks exactly where the source data doesn't cover it.
// Single source of truth for "is this weekday's typical curve trustworthy yet." Reused by the
// per-day overlay gating below and by the toggle's enable/disable check, so a future change to
// the threshold rule (say, requiring distinct weeks rather than distinct days) is a one-line
// change instead of a find-and-fix across the file.
function isDowCurveReady(curve, minDays) {
  return !!curve && curve.days >= minDays
}

// Days are walked as if every local day were 24 UTC hours; on the two DST-change days a year
// that's off by an hour, which is fine for a faint reference line. For 'dow', a weekday with
// fewer than `minDowDays` distinct historical days is treated as having no curve yet, so the
// line has a visible gap over that day instead of an average of one, which isn't "typical."
function typicalOverlayPoints(typicalLot, sinceMs, untilMs, kind, minDowDays = 0) {
  if (!typicalLot) return []
  const pts = []
  let dayStart = nextLocalMidnight(sinceMs - 25 * 3600_000)
  let guard = 0
  while (dayStart <= untilMs && guard++ < 400) {
    let curve = kind === 'dow'
      ? typicalLot.dayOfWeek.find((d) => d.weekday === localWeekday(dayStart + 3600_000))
      : typicalLot.day
    if (kind === 'dow' && !isDowCurveReady(curve, minDowDays)) curve = null
    if (curve) {
      for (let h = 0; h < 24; h++) {
        const v = curve.hours[h]
        if (v === null || v === undefined) continue
        const ms = dayStart + h * 3600_000
        if (ms < sinceMs || ms > untilMs) continue
        pts.push({ ms, p: v })
      }
    }
    dayStart = nextLocalMidnight(dayStart + 1000)
  }
  return pts
}

function chooseTicks(sinceMs, untilMs, width) {
  const span = untilMs - sinceMs
  const target = Math.max(3, Math.min(8, Math.floor(width / 110)))
  const steps = [15, 30, 60, 120, 180, 360, 720].map((m) => m * 60_000)
  const rough = span / target
  let step = steps.find((s) => s >= rough)
  const ticks = []
  if (step) {
    // Sub-day steps: align to the airport's local clock, not UTC.
    const offset = zoneOffsetMs(sinceMs)
    let t = Math.ceil((sinceMs + offset) / step) * step - offset
    for (; t <= untilMs; t += step) ticks.push({ ms: t, label: fmt.time.format(new Date(t)), kind: 'time' })
    return ticks
  }
  const days = Math.max(1, Math.round(rough / 86_400_000))
  let t = nextLocalMidnight(sinceMs)
  let i = 0
  while (t <= untilMs) {
    if (i % days === 0) ticks.push({ ms: t, label: fmt.date.format(new Date(t)), kind: 'date' })
    t = nextLocalMidnight(t + 1000)
    i++
  }
  return ticks
}

function legendEntry(label, colorVar, dashed = false) {
  const li = document.createElement('li')
  li.style.setProperty('--c', colorVar)
  const key = document.createElement('span')
  key.className = dashed ? 'key key-dashed' : 'key'
  key.setAttribute('aria-hidden', 'true')
  li.append(key, document.createTextNode(label))
  els.legend.append(li)
}

function renderLegend(lots) {
  els.legend.replaceChildren()
  lots.forEach((lot, i) => legendEntry(shortName(lot.lotName), lotColorVar(lot.lotId, i)))
}

let chartGeom = null

// Hovering a stat tile dims every other lot's lines (main + typical baselines) to 30%
// opacity so the hovered lot's line stands out. No-ops when the chart isn't rendered
// (table view, or before the first load).
function setLotHover(lotId) {
  if (!chartGeom) return
  for (const s of chartGeom.series) {
    const dim = lotId != null && s.lot.lotId !== lotId
    for (const el of s.dimEls) el.classList.toggle('dimmed', dim)
  }
}

function renderChart(history) {
  const svg = els.chart
  svg.replaceChildren()
  chartGeom = null
  state.hoverIndex = null
  hideTooltip()

  const lots = history.lots
  const hasData = lots.some((l) => l.points.length > 0)
  els.chartEmpty.hidden = hasData
  renderLegend(lots)
  if (!hasData) return

  const width = Math.max(320, svg.clientWidth || svg.parentElement.clientWidth)
  const height = svg.clientHeight || 340
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`)
  const m = { top: 14, right: 104, bottom: 30, left: 52 }
  const plotW = width - m.left - m.right
  const plotH = height - m.top - m.bottom

  const sinceMs = Date.parse(history.sinceAt)
  const untilMs = Date.parse(history.untilAt)
  const spanMs = Math.max(1, untilMs - sinceMs)
  const x = (ms) => m.left + ((ms - sinceMs) / spanMs) * plotW
  const y = (p) => m.top + plotH - (Math.min(100, Math.max(0, p)) / 100) * plotH

  // Grid + y axis, in percent available (100% at top). The site's "Limited" status is 75%+
  // occupied, i.e. 25% or less available, so that's where the threshold line lands now.
  for (const v of [0, 25, 50, 75, 100]) {
    svg.append(svgEl('line', { x1: m.left, x2: m.left + plotW, y1: y(v), y2: y(v), class: v === 0 ? 'baseline' : v === 25 ? 'threshold' : 'gridline' }))
    const label = svgEl('text', { x: m.left - 8, y: y(v) + 4, 'text-anchor': 'end', class: 'tick-label' })
    label.textContent = `${v}%`
    svg.append(label)
  }
  // Threshold annotation lives in the axis gutter so it never sits on a line.
  const note = svgEl('text', { x: m.left - 8, y: y(25) + 15, 'text-anchor': 'end', class: 'note-label' })
  note.textContent = 'Limited'
  svg.append(note)

  // X ticks.
  for (const tick of chooseTicks(sinceMs, untilMs, plotW)) {
    const tx = x(tick.ms)
    svg.append(svgEl('line', { x1: tx, x2: tx, y1: m.top + plotH, y2: m.top + plotH + 4, class: 'baseline' }))
    const label = svgEl('text', { x: tx, y: m.top + plotH + 18, 'text-anchor': 'middle', class: 'tick-label' })
    label.textContent = tick.label
    svg.append(label)
  }

  // Break the path only on a real outage, not on normal quiet stretches. Readings are stored
  // on change only (see README), so two genuine, healthy samples for a lot can legitimately
  // sit 15-20+ minutes apart even though the poller never missed a beat. Gauging the gap off
  // the chart's display bucket (as small as 60s) broke almost every segment into its own
  // dash. Gauge it off the poller's real cadence instead, with enough slack to absorb a few
  // backed-off retries. On 30d/all the display bucket (1h+) is itself wider than that, so
  // adjacent buckets must never count as a gap; only a missing bucket does.
  const pollIntervalMs = state.latest?.poller?.intervalMs ?? 5 * 60_000
  const bucketMs = (history.bucketSeconds || 60) * 1000
  const gapMs = Math.max(30 * 60_000, pollIntervalMs * 6, bucketMs * 2)

  // Outage bands: shade every stretch the server reports with no new readings, so a gap
  // reads as "the feed stopped" instead of empty chart. Same gapMs as the path breaks, so a
  // band never sits under a line that runs straight through it. Nothing is interpolated.
  for (const gap of history.gaps ?? []) {
    const fromMs = Math.max(sinceMs, Date.parse(gap.fromAt))
    const toMs = Math.min(untilMs, Date.parse(gap.toAt))
    if (toMs - fromMs <= 0 || Date.parse(gap.toAt) - Date.parse(gap.fromAt) <= gapMs) continue
    const bx = x(fromMs)
    const bw = Math.max(2, x(toMs) - bx)
    const band = svgEl('rect', { x: bx, y: m.top, width: bw, height: plotH, class: `gap-band gap-${gap.cause}` })
    svg.append(band)
    // Labels only where they fit inside the band; a narrow band falls back to the short form.
    if (bw >= 60) {
      const text = svgEl('text', { x: bx + bw / 2, y: m.top + 14, 'text-anchor': 'middle', class: 'gap-label' })
      text.textContent = (bw >= 130 ? GAP_LABEL[gap.cause] : GAP_SHORT_LABEL[gap.cause]) ?? 'No data'
      svg.append(text)
      if (bw >= 160) {
        const sub = svgEl('text', { x: bx + bw / 2, y: m.top + 28, 'text-anchor': 'middle', class: 'gap-sub' })
        sub.textContent = gapSpanText(gap)
        svg.append(sub)
      }
    }
  }

  // Flight markers: one vertical line per scheduled flight, drawn before the lot series so
  // real occupancy lines always paint on top. Disabled for now (FLIGHTS_CHART_MARKERS_ENABLED)
  // — too cluttered even scoped to short ranges — but left wired up to re-enable later.
  const flightsOn =
    FLIGHTS_CHART_MARKERS_ENABLED &&
    (state.showArrivals || state.showDepartures) &&
    FLIGHTS_SUPPORTED_RANGES.has(state.range) &&
    state.flights
  if (flightsOn) {
    for (const f of state.flights.flights) {
      if (f.type === 'arrival' && !state.showArrivals) continue
      if (f.type === 'departure' && !state.showDepartures) continue
      const ms = Date.parse(f.scheduledAt)
      if (ms < sinceMs || ms > untilMs) continue
      const fx = x(ms)
      const line = svgEl('line', { x1: fx, x2: fx, y1: m.top, y2: m.top + plotH, class: `flight-line flight-${f.type}` })
      const title = svgEl('title', {})
      title.textContent = `${f.type === 'arrival' ? 'Arriving' : 'Departing'} ${fmt.time.format(new Date(ms))} · ${f.airline} ${f.flightNumber} · ${f.city}`
      line.append(title)
      svg.append(line)
    }
    if (state.showArrivals) legendEntry('Arrivals', 'var(--flight-arrival)', true)
    if (state.showDepartures) legendEntry('Departures', 'var(--flight-departure)', true)
  }

  // Series (path breaks use gapMs, defined with the outage bands above).
  const typicalOn = (state.showTypicalDay || state.showTypicalDow) && TYPICAL_SUPPORTED_RANGES.has(state.range)
  const minDowDays = state.typical?.minDaysForDayOfWeek ?? 3
  const series = lots.map((lot, i) => {
    const color = lotColorVar(lot.lotId, i)
    const pts = lot.points.map(([ts, occ, tot]) => ({ ms: ts * 1000, p: avail(pct(occ, tot)), occ, tot }))
    const runs = []
    let current = []
    let prevMs = null
    for (const pt of pts) {
      if (prevMs !== null && pt.ms - prevMs > gapMs) { runs.push(current); current = [] }
      current.push(pt)
      prevMs = pt.ms
    }
    if (current.length) runs.push(current)
    const d = runs.map((run) => smoothPath(run.map((pt) => ({ x: x(pt.ms), y: y(pt.p) })))).join(' ')

    // Baselines draw first, so the real reading always sits on top as the clearest line,
    // even where the two cross. Element refs are kept so hovering a tile can dim every line
    // belonging to the other lots, baselines included.
    const dimEls = []
    if (typicalOn) {
      const typicalLot = state.typical?.lots.find((l) => l.lotId === lot.lotId)
      if (typicalLot) {
        if (state.showTypicalDay) {
          const dayD = smoothPath(typicalOverlayPoints(typicalLot, sinceMs, untilMs, 'day').map((pt) => ({ x: x(pt.ms), y: y(avail(pt.p)) })))
          if (dayD) {
            const dayEl = svgEl('path', { d: dayD, class: 'series typical typical-day', stroke: color })
            svg.append(dayEl)
            dimEls.push(dayEl)
          }
        }
        if (state.showTypicalDow) {
          const dowD = smoothPath(typicalOverlayPoints(typicalLot, sinceMs, untilMs, 'dow', minDowDays).map((pt) => ({ x: x(pt.ms), y: y(avail(pt.p)) })))
          if (dowD) {
            const dowEl = svgEl('path', { d: dowD, class: 'series typical typical-dow', stroke: color })
            svg.append(dowEl)
            dimEls.push(dowEl)
          }
        }
      }
    }

    const path = svgEl('path', { d, class: 'series', stroke: color })
    svg.append(path)
    dimEls.push(path)
    return { lot, color, pts, endY: pts.length ? y(pts[pts.length - 1].p) : null, dimEls }
  })

  // End markers and direct labels, pushed apart so they never collide.
  const labeled = series.filter((s) => s.endY !== null).sort((a, b) => a.endY - b.endY)
  let prevLabelY = -Infinity
  for (const s of labeled) {
    s.labelY = Math.max(s.endY, prevLabelY + 15)
    prevLabelY = s.labelY
  }
  for (const s of labeled) {
    const last = s.pts[s.pts.length - 1]
    svg.append(svgEl('circle', { cx: x(last.ms), cy: s.endY, r: 4, fill: s.color, class: 'end-marker' }))
    const label = svgEl('text', { x: m.left + plotW + 12, y: (s.labelY ?? s.endY) + 4, class: 'end-label' })
    label.textContent = `${shortName(s.lot.lotName)} ${Math.round(last.p)}%`
    svg.append(label)
  }

  // Hover layer: crosshair snaps to the nearest sampled time across all lots.
  const xsSet = new Set()
  for (const s of series) for (const pt of s.pts) xsSet.add(pt.ms)
  const xs = [...xsSet].sort((a, b) => a - b)
  const crosshair = svgEl('line', { class: 'crosshair', y1: m.top, y2: m.top + plotH, visibility: 'hidden' })
  const dots = series.map((s) => svgEl('circle', { r: 4.5, fill: s.color, class: 'hover-dot', visibility: 'hidden' }))
  const hit = svgEl('rect', { x: m.left, y: m.top, width: plotW, height: plotH, class: 'hit' })
  svg.append(crosshair, ...dots, hit)
  chartGeom = { x, y, xs, series, crosshair, dots, m, plotW, width }

  hit.addEventListener('pointermove', (ev) => {
    const rect = svg.getBoundingClientRect()
    const px = ((ev.clientX - rect.left) / rect.width) * width
    const ms = sinceMs + ((px - m.left) / plotW) * spanMs
    showHover(nearestIndex(xs, ms))
  })
  hit.addEventListener('pointerleave', () => showHover(null))
  svg.addEventListener('keydown', (ev) => {
    if (!chartGeom) return
    const n = xs.length
    let idx = state.hoverIndex ?? n - 1
    if (ev.key === 'ArrowLeft') idx = Math.max(0, idx - 1)
    else if (ev.key === 'ArrowRight') idx = Math.min(n - 1, idx + 1)
    else if (ev.key === 'Home') idx = 0
    else if (ev.key === 'End') idx = n - 1
    else if (ev.key === 'Escape') { showHover(null); return }
    else return
    ev.preventDefault()
    showHover(idx)
  })
  svg.addEventListener('blur', () => showHover(null))
}

function nearestIndex(xs, ms) {
  let lo = 0
  let hi = xs.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (xs[mid] < ms) lo = mid + 1
    else hi = mid
  }
  if (lo > 0 && Math.abs(xs[lo - 1] - ms) < Math.abs(xs[lo] - ms)) lo--
  return lo
}

function showHover(index) {
  const g = chartGeom
  if (!g) return
  state.hoverIndex = index
  if (index === null) {
    g.crosshair.setAttribute('visibility', 'hidden')
    g.dots.forEach((d) => d.setAttribute('visibility', 'hidden'))
    hideTooltip()
    els.chartStatus.textContent = ''
    return
  }
  const ms = g.xs[index]
  const cx = g.x(ms)
  g.crosshair.setAttribute('x1', cx)
  g.crosshair.setAttribute('x2', cx)
  g.crosshair.setAttribute('visibility', 'visible')

  const rows = []
  g.series.forEach((s, i) => {
    // Nearest point of this series within one bucket of the crosshair; otherwise no reading.
    const j = nearestIndex(s.pts.map((p) => p.ms), ms)
    const pt = s.pts[j]
    const tol = (state.history.bucketSeconds || 60) * 1000 * 1.5
    if (pt && Math.abs(pt.ms - ms) <= tol) {
      g.dots[i].setAttribute('cx', g.x(pt.ms))
      g.dots[i].setAttribute('cy', g.y(pt.p))
      g.dots[i].setAttribute('visibility', 'visible')
      rows.push({ color: s.color, name: shortName(s.lot.lotName), p: pt.p, free: pt.tot - pt.occ })
    } else {
      g.dots[i].setAttribute('visibility', 'hidden')
    }
  })

  const tip = els.tooltip
  tip.replaceChildren()
  const when = document.createElement('div')
  when.className = 'when'
  when.textContent = fmt.dateTime.format(new Date(ms))
  tip.append(when)
  for (const r of rows) {
    const row = document.createElement('div')
    row.className = 'row'
    row.style.setProperty('--c', r.color)
    const k = document.createElement('span'); k.className = 'k'
    const v = document.createElement('span'); v.className = 'v'; v.textContent = `${r.free.toLocaleString()} open spots`
    const n = document.createElement('span'); n.className = 'n'; n.textContent = r.name
    row.append(k, v, n)
    tip.append(row)
  }
  tip.hidden = false

  // The SVG is exposed to assistive tech as a single opaque image (role="img"), so arrow-key
  // scrubbing needs this text equivalent. aria-live announces it; screen readers skip re-announcing
  // when the text is unchanged, so rapid pointermove over the same bucket doesn't spam it.
  els.chartStatus.textContent = rows.length
    ? `${fmt.dateTime.format(new Date(ms))}: ${rows.map((r) => `${r.name} ${r.free.toLocaleString()} open spots`).join(', ')}`
    : `${fmt.dateTime.format(new Date(ms))}: no reading`

  const wrapW = els.chartWrap.clientWidth
  const pxX = (cx / g.width) * wrapW
  const tipW = tip.offsetWidth
  const left = pxX + 14 + tipW > wrapW ? pxX - 14 - tipW : pxX + 14
  tip.style.left = `${Math.max(0, left)}px`
}

function hideTooltip() {
  els.tooltip.hidden = true
}

// ---- Flight board --------------------------------------------------------------

// Small paper-plane glyph, rotated to read as landing (nose down-right) or taking off
// (nose up-right) — the same convention flight-search sites use for arrivals/departures.
// Colored with the same --flight-arrival/--flight-departure tokens the (currently disabled)
// chart overlay uses, so the two features share a visual language even while one is off.
function flightIconSvg(kind) {
  const rotate = kind === 'arrival' ? 45 : -45
  const color = kind === 'arrival' ? 'var(--flight-arrival)' : 'var(--flight-departure)'
  const svg = svgEl('svg', { viewBox: '0 0 24 24', width: 14, height: 14, class: 'flight-icon', 'aria-hidden': 'true' })
  svg.append(svgEl('path', { d: 'M2 21l21-9L2 3v7l15 2-15 2z', fill: color, transform: `rotate(${rotate} 12 12)` }))
  return svg
}

// The board's window now follows the chart's range selector (6h up to All), not just "today",
// so on 7d+ it can span many days of flights with same-looking times. Past this row count we
// truncate rather than dump an unbounded table, and past a day span we print the date too so
// two flights at the same clock time on different days aren't indistinguishable.
const FLIGHTS_BOARD_ROW_CAP = 300

function renderFlightsColumn(table, emptyEl, headingEl, kind, label, rows, multiDay) {
  // Stale flights (see isFlightStale server-side) fell off the live board without ever
  // reaching a confirmed outcome. Rather than show a per-row "unconfirmed" warning — which
  // reads as broken even though it's accurate — this board just drops them silently, the same
  // way the live source itself drops completed arrivals with no explicit status. Flights that
  // *did* reach a confirmed outcome (arrived, departed, cancelled) drop off too, once they're
  // far enough past due that they're no longer "what's happening now."
  const sorted = rows
    .filter((f) => !f.stale && !isFlightDoneAndOld(f))
    .sort((a, b) => Date.parse(a.expectedAt) - Date.parse(b.expectedAt))
  headingEl.replaceChildren(flightIconSvg(kind), document.createTextNode(` ${label} (${sorted.length})`))
  table.replaceChildren()

  if (!sorted.length) {
    emptyEl.hidden = false
    emptyEl.textContent = `No ${label.toLowerCase()} in this window.`
    return
  }
  emptyEl.hidden = true

  const shown = sorted.slice(0, FLIGHTS_BOARD_ROW_CAP)
  const timeFmt = multiDay ? fmt.dateTime : fmt.time

  const thead = document.createElement('thead')
  const hr = document.createElement('tr')
  for (const col of ['Time', 'Flight', 'City', 'Gate', 'Status']) {
    const th = document.createElement('th')
    th.scope = 'col'
    th.textContent = col
    hr.append(th)
  }
  thead.append(hr)

  const tbody = document.createElement('tbody')
  for (const f of shown) {
    const tr = document.createElement('tr')

    // Expected time first, since that's when the plane actually shows up. The scheduled time
    // rides along underneath whenever the board has revised it.
    const timeTd = document.createElement('td')
    timeTd.textContent = timeFmt.format(new Date(f.expectedAt))
    if (Math.abs(Date.parse(f.expectedAt) - Date.parse(f.scheduledAt)) >= 60_000) {
      const sched = document.createElement('span')
      sched.className = 'sched'
      sched.textContent = `sched ${timeFmt.format(new Date(f.scheduledAt))}`
      timeTd.append(sched)
    }
    tr.append(timeTd)

    // Airline + flight number combined into one cell, linked to FlightAware when the airline
    // maps to a known ICAO code (see AIRLINE_ICAO) — an unmapped airline just renders as text
    // rather than guessing a link that might point at the wrong flight.
    const flightTd = document.createElement('td')
    const flightLabel = `${f.airline} ${f.flightNumber}`
    const url = flightAwareUrl(f.airlineCode, f.flightNumber)
    if (url) {
      const a = document.createElement('a')
      a.href = url
      a.target = '_blank'
      a.rel = 'noopener noreferrer'
      a.textContent = flightLabel
      flightTd.append(a)
    } else {
      flightTd.textContent = flightLabel
    }
    tr.append(flightTd)

    for (const v of [f.city, f.gate || '–']) {
      const td = document.createElement('td')
      td.textContent = v
      tr.append(td)
    }
    const statusTd = document.createElement('td')
    statusTd.textContent = f.status || '–'
    if (FLIGHT_STATUS_CLASS[f.status]) statusTd.className = FLIGHT_STATUS_CLASS[f.status]
    tr.append(statusTd)
    tbody.append(tr)
  }
  table.append(thead, tbody)

  if (sorted.length > shown.length) {
    const tfoot = document.createElement('tfoot')
    const tr = document.createElement('tr')
    const td = document.createElement('td')
    td.colSpan = 5
    td.textContent = `Showing the first ${shown.length.toLocaleString()} of ${sorted.length.toLocaleString()} — narrow the chart's range above to see the rest.`
    tr.append(td)
    tfoot.append(tr)
    table.append(tfoot)
  }
}

function renderFlightsBoard(data) {
  renderTrackerStatus('flights', 'Flights', data.poller)
  const total = data.flights.length
  const multiDay = Date.parse(data.untilAt) - Date.parse(data.sinceAt) > 36 * 3600_000
  els.flightsBoardSub.textContent = total
    ? `${total.toLocaleString()} flight${total === 1 ? '' : 's'}, ${fmt.dateTime.format(new Date(data.sinceAt))} to ${fmt.dateTime.format(new Date(data.untilAt))}.`
    : `No flights ${fmt.dateTime.format(new Date(data.sinceAt))} to ${fmt.dateTime.format(new Date(data.untilAt))}.`
  renderFlightsColumn(els.arrivalsTable, els.arrivalsEmpty, els.arrivalsHeading, 'arrival', 'Arrivals', data.flights.filter((f) => f.type === 'arrival'), multiDay)
  renderFlightsColumn(els.departuresTable, els.departuresEmpty, els.departuresHeading, 'departure', 'Departures', data.flights.filter((f) => f.type === 'departure'), multiDay)
}

// ---- Orchestration -------------------------------------------------------------

async function loadLatest() {
  try {
    // This 24h/15-min-bucket fetch is independent of the chart's range selector, so the tile
    // trend badges and 24h bar chart don't shift when you switch the chart to 7d/30d/all.
    const [latest, mini] = await Promise.all([
      getJson('api/latest'),
      getJson(`api/history?range=${MINI_HISTORY_RANGE}`),
    ])
    state.latest = latest
    state.mini = mini
    rerenderTiles()
    renderSourceLine(latest)
  } catch (err) {
    const message = `Could not reach the service (${err.message})`
    els.sourceLine.textContent = message
    els.sourceLineMobile.textContent = message
  }
}

// Guards against overlapping loadHistory() calls resolving out of order (e.g. clicking two
// range buttons in quick succession) — only the response matching the most recently *started*
// request is allowed to touch state or render.
let historyRequestSeq = 0

async function loadHistory() {
  const seq = ++historyRequestSeq
  els.chartWrap.classList.add('loading')
  try {
    const history = await getJson(`api/history?range=${encodeURIComponent(state.range)}`)
    if (seq !== historyRequestSeq) return // a newer request has since started; drop this one
    state.history = history
    // The flight board (and, if re-enabled, the chart's flight-line overlay) both track
    // whatever window the range selector just resolved, so one fetch feeds both.
    const sinceTs = Math.floor(Date.parse(state.history.sinceAt) / 1000)
    const untilTs = Math.floor(Date.parse(state.history.untilAt) / 1000)
    try {
      const flights = await getJson(`api/flights?since=${sinceTs}&until=${untilTs}`)
      if (seq !== historyRequestSeq) return
      state.flights = flights
      renderFlightsBoard(state.flights)
    } catch (err) {
      if (seq !== historyRequestSeq) return
      state.flights = null // the chart overlay is a nice-to-have; failure shouldn't break it
      els.flightsBoardSub.textContent = `Could not load flights (${err.message})`
    }
    updateFlightsAvailability()
    renderChart(state.history)
  } catch (err) {
    if (seq !== historyRequestSeq) return
    els.chartEmpty.hidden = false
    els.chartEmpty.textContent = `Could not load history (${err.message})`
  } finally {
    if (seq === historyRequestSeq) els.chartWrap.classList.remove('loading')
  }
}

async function loadTypical() {
  try {
    state.typical = await getJson('api/typical')
  } catch {
    // Baselines are a nice-to-have; a failed fetch shouldn't take down the main chart.
    state.typical = null
  }
  updateTypicalAvailability()
  rerenderTiles()
  if (state.history) renderChart(state.history)
}

// Hides the whole toggle group on ranges it doesn't support, and independently disables
// "Same weekday" until at least one weekday has enough distinct historical days to average.
// "Typical day" only needs *some* data, so it's enabled as soon as the fetch succeeds.
function updateTypicalAvailability() {
  const supported = TYPICAL_SUPPORTED_RANGES.has(state.range)
  els.typicalGroup.hidden = !supported
  if (!supported) return

  const dayBtn = els.typicalGroup.querySelector('[data-typical="day"]')
  const dowBtn = els.typicalGroup.querySelector('[data-typical="dow"]')
  const hasTypical = !!state.typical

  dayBtn.disabled = !hasTypical
  dayBtn.setAttribute('aria-pressed', String(state.showTypicalDay))

  const minDays = state.typical?.minDaysForDayOfWeek ?? 3
  const dowReady = hasTypical && state.typical.lots.some((l) => l.dayOfWeek.some((d) => isDowCurveReady(d, minDays)))
  dowBtn.disabled = !dowReady
  dowBtn.title = dowReady
    ? "Overlay each lot's average occupancy for this weekday only."
    : `Still collecting: needs at least ${minDays} weeks of same-weekday data.`
  dowBtn.setAttribute('aria-pressed', String(state.showTypicalDow))
}

els.typicalGroup.addEventListener('click', (ev) => {
  const btn = ev.target.closest('button[data-typical]')
  if (!btn || btn.disabled) return
  const key = btn.dataset.typical
  const on = btn.getAttribute('aria-pressed') !== 'true'
  btn.setAttribute('aria-pressed', String(on))
  if (key === 'day') state.showTypicalDay = on
  else state.showTypicalDow = on
  try { localStorage.setItem(`sba-typical-${key}`, on ? '1' : '0') } catch {}
  if (state.history) renderChart(state.history)
})

// Hides the group on ranges it doesn't support (see FLIGHTS_SUPPORTED_RANGES). No data-
// readiness gating like the typical toggles need — a flight either falls in the window or
// it doesn't — so this just reflects current toggle state onto the buttons.
function updateFlightsAvailability() {
  if (!FLIGHTS_CHART_MARKERS_ENABLED) { els.flightsGroup.hidden = true; return }
  const supported = FLIGHTS_SUPPORTED_RANGES.has(state.range)
  els.flightsGroup.hidden = !supported
  if (!supported) return
  els.flightsGroup.querySelector('[data-flights="arrival"]').setAttribute('aria-pressed', String(state.showArrivals))
  els.flightsGroup.querySelector('[data-flights="departure"]').setAttribute('aria-pressed', String(state.showDepartures))
}

els.flightsGroup.addEventListener('click', (ev) => {
  const btn = ev.target.closest('button[data-flights]')
  if (!btn) return
  const key = btn.dataset.flights
  const on = btn.getAttribute('aria-pressed') !== 'true'
  btn.setAttribute('aria-pressed', String(on))
  if (key === 'arrival') state.showArrivals = on
  else state.showDepartures = on
  try { localStorage.setItem(`sba-flights-${key}`, on ? '1' : '0') } catch {}
  if (state.history) renderChart(state.history)
})

function setPressed(group, attr, value) {
  for (const b of group.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset[attr] === value))
}

$('range-group').addEventListener('click', (ev) => {
  const btn = ev.target.closest('button[data-range]')
  if (!btn || btn.dataset.range === state.range) return
  state.range = btn.dataset.range
  setPressed($('range-group'), 'range', state.range)
  try { localStorage.setItem('sba-range', state.range) } catch {}
  updateTypicalAvailability()
  updateFlightsAvailability()
  loadHistory()
})
// The history chart starts collapsed on phones, where most visits are a quick check of the
// tiles; elsewhere it starts open. Whatever the viewer picks last is remembered.
const vizCard = $('viz-card')
try {
  const saved = localStorage.getItem('sba-history-open')
  vizCard.open = saved !== null ? saved === '1' : !matchMedia('(max-width: 560px)').matches
} catch {
  vizCard.open = !matchMedia('(max-width: 560px)').matches
}
vizCard.addEventListener('toggle', () => {
  try { localStorage.setItem('sba-history-open', vizCard.open ? '1' : '0') } catch {}
  if (vizCard.open && state.history) renderChart(state.history)
})

let resizeTimer
new ResizeObserver(() => {
  clearTimeout(resizeTimer)
  resizeTimer = setTimeout(() => { if (state.history) renderChart(state.history) }, 80)
}).observe(els.chartWrap)

try {
  const saved = localStorage.getItem('sba-range')
  if (saved && $('range-group').querySelector(`[data-range="${saved}"]`)) {
    state.range = saved
    setPressed($('range-group'), 'range', saved)
  }
  const savedDay = localStorage.getItem('sba-typical-day')
  if (savedDay !== null) state.showTypicalDay = savedDay === '1'
  const savedDow = localStorage.getItem('sba-typical-dow')
  if (savedDow !== null) state.showTypicalDow = savedDow === '1'
  const savedArrivals = localStorage.getItem('sba-flights-arrival')
  if (savedArrivals !== null) state.showArrivals = savedArrivals === '1'
  const savedDepartures = localStorage.getItem('sba-flights-departure')
  if (savedDepartures !== null) state.showDepartures = savedDepartures === '1'
} catch {}
updateTypicalAvailability()
updateFlightsAvailability()
initWhen()

loadLatest()
loadHistory()
loadTypical()
setInterval(() => {
  if (document.visibilityState !== 'visible') return
  loadLatest()
  loadHistory()
}, REFRESH_MS)
setInterval(() => {
  if (document.visibilityState !== 'visible') return
  loadTypical()
}, TYPICAL_REFRESH_MS)
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') { loadLatest(); loadHistory() }
})
