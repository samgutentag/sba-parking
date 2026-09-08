'use strict'

// Color follows the lot, never its position in the current result set.
const LOT_SLOT = { '2': 'series-1', '3': 'series-2', '4': 'series-3' }
const FALLBACK_SLOTS = ['series-4', 'series-5', 'series-6']
const STATUS = {
  open: { token: '--status-good', glyph: '✓' },
  busy: { token: '--status-warning', glyph: '◐' },
  limited: { token: '--status-serious', glyph: '▲' },
  full: { token: '--status-critical', glyph: '■' },
}
const REFRESH_MS = 60_000

const state = {
  range: '24h',
  view: 'chart',
  timeZone: 'America/Los_Angeles',
  latest: null,
  history: null,
  hoverIndex: null,
}

const $ = (id) => document.getElementById(id)
const els = {
  sourceLine: $('source-line'), tiles: $('tiles'), legend: $('legend'), chart: $('chart'),
  chartWrap: $('chart-wrap'), chartEmpty: $('chart-empty'), tooltip: $('tooltip'),
  chartCard: $('chart-card'), tableCard: $('table-card'), table: $('table'), tableSub: $('table-sub'),
  historyLine: $('history-line'),
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
function levelFor(percent) {
  if (percent >= 100) return 'full'
  if (percent >= 75) return 'limited'
  if (percent >= 50) return 'busy'
  return 'open'
}

// Time formatting, always in the airport's zone.
const fmt = {
  time: new Intl.DateTimeFormat('en-US', { timeZone: state.timeZone, hour: 'numeric', minute: '2-digit' }),
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

async function getJson(url) {
  const res = await fetch(url, { cache: 'no-store' })
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`)
  return res.json()
}

// ---- Tiles -------------------------------------------------------------------

function renderTiles(latest) {
  els.tiles.replaceChildren()
  if (!latest.lots.length) {
    const p = document.createElement('p')
    p.className = 'empty'
    p.textContent = 'No readings yet. First poll is in progress.'
    els.tiles.append(p)
    return
  }
  latest.lots.forEach((lot, i) => {
    const level = lot.level ?? levelFor(lot.percent)
    const status = STATUS[level]
    const tile = document.createElement('article')
    tile.className = 'tile'
    tile.style.setProperty('--lot-color', lotColorVar(lot.lotId, i))
    tile.style.setProperty('--chip-color', `var(${status.token})`)

    const label = document.createElement('div')
    label.className = 'label'
    const name = document.createElement('span')
    name.textContent = lot.lotName
    const chip = document.createElement('span')
    chip.className = 'chip'
    const glyph = document.createElement('span')
    glyph.className = 'glyph'
    glyph.setAttribute('aria-hidden', 'true')
    glyph.textContent = status.glyph
    chip.append(glyph, document.createTextNode(lot.status))
    label.append(name, chip)

    const value = document.createElement('div')
    value.className = 'value'
    value.textContent = lot.free.toLocaleString()
    const small = document.createElement('small')
    small.textContent = `free of ${lot.total.toLocaleString()}`
    value.append(small)

    const meter = document.createElement('div')
    meter.className = 'meter'
    meter.setAttribute('role', 'meter')
    meter.setAttribute('aria-valuemin', '0')
    meter.setAttribute('aria-valuemax', '100')
    meter.setAttribute('aria-valuenow', String(Math.round(lot.percent)))
    meter.setAttribute('aria-label', `${lot.lotName} occupancy`)
    const fill = document.createElement('span')
    fill.style.width = `${Math.min(100, lot.percent)}%`
    meter.append(fill)

    const detail = document.createElement('div')
    detail.className = 'detail'
    const left = document.createElement('span')
    left.textContent = `${Math.round(lot.percent)}% full · ${lot.occupied.toLocaleString()} parked`
    const right = document.createElement('span')
    right.textContent = `as of ${fmt.time.format(new Date(lot.sourceUpdatedAt))}`
    detail.append(left, right)

    tile.append(label, value, meter, detail)
    els.tiles.append(tile)
  })
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
    if (p.lastPollOk === false && p.lastError) text += ` failed (${p.lastError})`
    else if (latest.lots[0]) text += ` · feed updated ${fmt.time.format(new Date(latest.lots[0].sourceUpdatedAt))} PT`
  }
  els.sourceLine.replaceChildren(dot, document.createTextNode(text))

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

function renderLegend(lots) {
  els.legend.replaceChildren()
  lots.forEach((lot, i) => {
    const li = document.createElement('li')
    li.style.setProperty('--c', lotColorVar(lot.lotId, i))
    const key = document.createElement('span')
    key.className = 'key'
    key.setAttribute('aria-hidden', 'true')
    li.append(key, document.createTextNode(shortName(lot.lotName)))
    els.legend.append(li)
  })
}

let chartGeom = null

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

  // Grid + y axis. Solid hairlines, muted labels. 75% is the site's "Limited" threshold.
  for (const v of [0, 25, 50, 75, 100]) {
    svg.append(svgEl('line', { x1: m.left, x2: m.left + plotW, y1: y(v), y2: y(v), class: v === 0 ? 'baseline' : v === 75 ? 'threshold' : 'gridline' }))
    const label = svgEl('text', { x: m.left - 8, y: y(v) + 4, 'text-anchor': 'end', class: 'tick-label' })
    label.textContent = `${v}%`
    svg.append(label)
  }
  // Threshold annotation lives in the axis gutter so it never sits on a line.
  const note = svgEl('text', { x: m.left - 8, y: y(75) + 15, 'text-anchor': 'end', class: 'note-label' })
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

  // Series. Break the path across gaps longer than three buckets so downtime shows as a gap.
  const gapMs = history.bucketSeconds * 3000 + 60_000
  const series = lots.map((lot, i) => {
    const color = lotColorVar(lot.lotId, i)
    const pts = lot.points.map(([ts, occ, tot]) => ({ ms: ts * 1000, p: pct(occ, tot), occ, tot }))
    let d = ''
    let prev = null
    for (const pt of pts) {
      const cmd = !prev || pt.ms - prev.ms > gapMs ? 'M' : 'L'
      d += `${cmd}${x(pt.ms).toFixed(1)},${y(pt.p).toFixed(1)}`
      prev = pt
    }
    const path = svgEl('path', { d, class: 'series', stroke: color })
    svg.append(path)
    return { lot, color, pts, endY: pts.length ? y(pts[pts.length - 1].p) : null }
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
    const v = document.createElement('span'); v.className = 'v'; v.textContent = `${Math.round(r.p)}%`
    const n = document.createElement('span'); n.className = 'n'; n.textContent = `${r.name} · ${r.free.toLocaleString()} free`
    row.append(k, v, n)
    tip.append(row)
  }
  tip.hidden = false
  const wrapW = els.chartWrap.clientWidth
  const pxX = (cx / g.width) * wrapW
  const tipW = tip.offsetWidth
  const left = pxX + 14 + tipW > wrapW ? pxX - 14 - tipW : pxX + 14
  tip.style.left = `${Math.max(0, left)}px`
}

function hideTooltip() {
  els.tooltip.hidden = true
}

// ---- Table -------------------------------------------------------------------

function renderTable(history) {
  const lots = history.lots
  const table = els.table
  table.replaceChildren()
  const byTs = new Map()
  lots.forEach((lot, i) => {
    for (const [ts, occ, tot] of lot.points) {
      if (!byTs.has(ts)) byTs.set(ts, new Array(lots.length).fill(null))
      byTs.get(ts)[i] = { occ, tot }
    }
  })
  const times = [...byTs.keys()].sort((a, b) => b - a)
  els.tableSub.textContent = times.length
    ? `${times.length.toLocaleString()} rows, one per ${history.bucketSeconds >= 3600 ? `${history.bucketSeconds / 3600} h` : `${history.bucketSeconds / 60} min`} bucket, newest first.`
    : 'No readings in this range yet.'

  const thead = document.createElement('thead')
  const hr = document.createElement('tr')
  const th0 = document.createElement('th')
  th0.textContent = 'Time (PT)'
  hr.append(th0)
  lots.forEach((lot, i) => {
    const th = document.createElement('th')
    th.style.setProperty('--c', lotColorVar(lot.lotId, i))
    const key = document.createElement('span'); key.className = 'key'
    th.append(key, document.createTextNode(`${shortName(lot.lotName)} free`))
    hr.append(th)
    const th2 = document.createElement('th')
    th2.textContent = '%'
    hr.append(th2)
  })
  thead.append(hr)
  const tbody = document.createElement('tbody')
  for (const ts of times.slice(0, 2000)) {
    const tr = document.createElement('tr')
    const td0 = document.createElement('td')
    td0.textContent = fmt.dateTime.format(new Date(ts * 1000))
    tr.append(td0)
    for (const cell of byTs.get(ts)) {
      const tdFree = document.createElement('td')
      const tdPct = document.createElement('td')
      if (cell) {
        tdFree.textContent = (cell.tot - cell.occ).toLocaleString()
        tdPct.textContent = `${Math.round(pct(cell.occ, cell.tot))}%`
      } else {
        tdFree.textContent = '–'
        tdPct.textContent = '–'
      }
      tr.append(tdFree, tdPct)
    }
    tbody.append(tr)
  }
  table.append(thead, tbody)
}

// ---- Orchestration -------------------------------------------------------------

async function loadLatest() {
  try {
    state.latest = await getJson('/api/latest')
    renderTiles(state.latest)
    renderSourceLine(state.latest)
  } catch (err) {
    els.sourceLine.textContent = `Could not reach the service (${err.message})`
  }
}

async function loadHistory() {
  els.chartWrap.classList.add('loading')
  try {
    state.history = await getJson(`/api/history?range=${encodeURIComponent(state.range)}`)
    renderChart(state.history)
    renderTable(state.history)
  } catch (err) {
    els.chartEmpty.hidden = false
    els.chartEmpty.textContent = `Could not load history (${err.message})`
  } finally {
    els.chartWrap.classList.remove('loading')
  }
}

function setPressed(group, attr, value) {
  for (const b of group.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset[attr] === value))
}

$('range-group').addEventListener('click', (ev) => {
  const btn = ev.target.closest('button[data-range]')
  if (!btn || btn.dataset.range === state.range) return
  state.range = btn.dataset.range
  setPressed($('range-group'), 'range', state.range)
  try { localStorage.setItem('sba-range', state.range) } catch {}
  loadHistory()
})
$('view-group').addEventListener('click', (ev) => {
  const btn = ev.target.closest('button[data-view]')
  if (!btn) return
  state.view = btn.dataset.view
  setPressed($('view-group'), 'view', state.view)
  els.chartCard.hidden = state.view !== 'chart'
  els.tableCard.hidden = state.view !== 'table'
  if (state.view === 'chart' && state.history) renderChart(state.history)
})

let resizeTimer
new ResizeObserver(() => {
  clearTimeout(resizeTimer)
  resizeTimer = setTimeout(() => { if (state.history && state.view === 'chart') renderChart(state.history) }, 80)
}).observe(els.chartWrap)

try {
  const saved = localStorage.getItem('sba-range')
  if (saved && $('range-group').querySelector(`[data-range="${saved}"]`)) {
    state.range = saved
    setPressed($('range-group'), 'range', saved)
  }
} catch {}

loadLatest()
loadHistory()
setInterval(() => {
  if (document.visibilityState !== 'visible') return
  loadLatest()
  loadHistory()
}, REFRESH_MS)
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') { loadLatest(); loadHistory() }
})
