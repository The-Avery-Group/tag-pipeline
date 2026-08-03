/**
 * kpiHelpers.js
 * Pure utility functions for KPI computation and date formatting.
 *
 * Date handling notes:
 *  - All dates coming from the app are ISO strings: 'YYYY-MM-DD'
 *  - new Date('YYYY-MM-DD') parses as UTC midnight — in negative UTC offset
 *    timezones this shifts to the previous calendar day when displayed locally.
 *  - Fix: append 'T00:00:00' (no Z) so the browser parses as LOCAL midnight.
 */
import { isRfiWorkflowOpportunity } from './noticeTypes.js'

// ── Date helpers ──────────────────────────────────────────────────────────

/**
 * Parse an ISO date string as local midnight (no timezone shift).
 * Returns an invalid Date if val is empty/null.
 */
function parseLocalDate(val) {
  if (!val) return new Date(NaN)
  const s = String(val).trim()
  // Already has time component — use as-is
  if (s.length > 10) return new Date(s)
  // 'YYYY-MM-DD' → parse as local midnight to avoid UTC offset shift
  return new Date(s + 'T00:00:00')
}

/**
 * Format a date value for display: 'Aug 15, 2025'
 * Accepts ISO strings, Excel serial numbers (already normalised by graphService),
 * or Date objects.
 */
export function formatDate(val) {
  if (!val && val !== 0) return '—'
  const d = parseLocalDate(val)
  if (isNaN(d.getTime())) return '—'
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

/**
 * Format a date value for display with time and local timezone abbreviation:
 * 'Aug 15, 2025, 5:00 PM EDT'. Falls back to date-only formatting if the
 * value has no time component (plain 'YYYY-MM-DD').
 */
export function formatDateTime(val) {
  if (!val && val !== 0) return '—'
  const s = String(val).trim()
  // No time component in the source value — nothing meaningful to show beyond the date
  if (s.length <= 10) return formatDate(val)
  const d = new Date(s)
  if (isNaN(d.getTime())) return formatDate(val)
  return d.toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
  })
}

/**
 * Returns true if the date is strictly before today (ignoring time).
 */
export function isOverdue(val) {
  if (!val) return false
  const d = parseLocalDate(val)
  if (isNaN(d.getTime())) return false
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  return d < today
}

// ── Greeting ──────────────────────────────────────────────────────────────

export function getGreeting(firstName) {
  const h = new Date().getHours()
  const time = h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'
  return firstName ? `${time}, ${firstName}` : time
}

// ── Phase ordering ────────────────────────────────────────────────────────

export function getPhaseOrder() {
  return [
    'Identified', 'Research', 'Qualified', 'Proposal',
    'Pending Award', 'Contract Awarded', 'Cancelled',
  ]
}

// ── KPI computation ───────────────────────────────────────────────────────

const C_PHASE    = 'TAG Opportunity Phase'
const C_VALUE    = 'Total Contract Value ($)*'
const C_OWNER    = 'Assigned To*'
const C_LASTMOD  = 'Last Modified*'
const C_ENDDATE  = 'Contract End Date*'
const C_AGENCY   = 'Agency*'
const C_OUTLOOK  = 'Opportunity Outlook'
const C_SUBMDATE = 'Submission Date (Response Date)*'
const C_PRIMESUB = 'Prime or Sub?'
// Confirmed exact column header for the contract classification concept.
const C_AWARDTYPE = 'Contract Classification*'
// "Contract Vehicle" already holds the actual vehicle NAME (e.g. "GSA OASIS+"),
// not an ID — "Contract Vehicle Number" is the separate ID field. Confirmed
// by the user; no lookup/resolution needed, this chart can be built now
// rather than waiting on the Phase 3 USASpending.gov lookup.
const C_VEHICLE = 'Contract Vehicle'

// ── Fiscal year helper ──────────────────────────────────────────────────

/**
 * US federal fiscal year for a given date: FY runs Oct 1 – Sep 30, and is
 * named for the calendar year it ENDS in (e.g. Oct 2025–Sep 2026 = FY2026).
 */
export function getFiscalYear(date) {
  const d = date instanceof Date ? date : parseLocalDate(date)
  if (isNaN(d.getTime())) return null
  const month = d.getMonth()   // 0-indexed, Oct = 9
  return month >= 9 ? d.getFullYear() + 1 : d.getFullYear()
}

// ── Expiring band helper ─────────────────────────────────────────────────

export const EXPIRING_BANDS = [
  { key: '0-6',   label: '0–6 months' },
  { key: '6-12',  label: '6–12 months' },
  { key: '12-18', label: '12–18 months' },
  { key: '18+',   label: '18+ months' },
]

/**
 * Which expiring-urgency band a Contract End Date falls into, relative to
 * today. Returns null for dates already in the past (already expired —
 * not a forward-looking "expiring soon" band) or missing/invalid dates.
 */
export function getEndDateBand(endDate) {
  const d = parseLocalDate(endDate)
  if (isNaN(d.getTime())) return null
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  if (d < today) return null
  const days = Math.round((d - today) / (1000 * 60 * 60 * 24))
  if (days <= 182)  return '0-6'     // ~6 months
  if (days <= 365)  return '6-12'
  if (days <= 548)  return '12-18'   // ~18 months
  return '18+'
}

/** Counts of upcoming opportunities per expiring band (see EXPIRING_BANDS). */
export function computeExpiringBands(pipeline = []) {
  const counts = { '0-6': 0, '6-12': 0, '12-18': 0, '18+': 0 }
  pipeline.forEach((o) => {
    const band = getEndDateBand(o[C_ENDDATE])
    if (band) counts[band]++
  })
  return counts
}

// ── RFI by month ──────────────────────────────────────────────────────────

/**
 * Returns the last `monthsBack` calendar months (including current) as an
 * array of { year, month, label, monthKey, count } objects, zero-filled for
 * empty months. Counts RFI and MRAS opportunities with a submission date, using
 * Submission Date (Response Date)* as the month reference. monthKey is a
 * stable 'YYYY-MM' identifier for filtering/URL use.
 */
export function computeRFIByMonth(pipeline = [], monthsBack = 10) {
  const months = []
  const now = new Date()
  const currentYear = now.getFullYear()

  for (let i = monthsBack - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
    const year = d.getFullYear()
    const monthName = d.toLocaleDateString('en-US', { month: 'short' })
    // Compact label — only show the year (as 'YY) when it differs from the
    // current calendar year, e.g. "Oct '25" vs plain "Jan" for this year.
    const label = year !== currentYear ? `${monthName} '${String(year).slice(-2)}` : monthName
    months.push({
      year,
      month: d.getMonth(),
      label,
      monthKey: `${year}-${String(d.getMonth() + 1).padStart(2, '0')}`,
      count: 0,
    })
  }

  pipeline.filter(isRfiWorkflowOpportunity).forEach((o) => {
    const d = parseLocalDate(o[C_SUBMDATE])
    if (isNaN(d.getTime())) return
    const bucket = months.find(
      (m) => m.year === d.getFullYear() && m.month === d.getMonth()
    )
    if (bucket) bucket.count++
  })

  return months
}

// ── Contract-by-year (recompete timeline) ──────────────────────────────────

/**
 * Contract value/count grouped by CALENDAR year, using Contract End Date —
 * this is a recompete-timeline view, not a forecast-of-new-awards view.
 * Excludes Cancelled opportunities (never became a real contract); includes
 * everything else, including Contract Awarded (an active, executing
 * contract still needs recompete planning around its end date).
 *
 * Windowed to (current year − 1) through (current year + 6) and zero-filled,
 * so one stray bad end-date far in the past/future can't silently skew the
 * chart's shape.
 */
export function computeContractByYear(pipeline = []) {
  const currentYear = new Date().getFullYear()
  const years = []
  for (let y = currentYear - 1; y <= currentYear + 6; y++) {
    years.push({ calYear: y, label: String(y), count: 0, value: 0 })
  }

  pipeline.forEach((o) => {
    if (o[C_PHASE] === 'Cancelled') return
    const d = parseLocalDate(o[C_ENDDATE])
    if (isNaN(d.getTime())) return
    const y = d.getFullYear()
    const bucket = years.find((b) => b.calYear === y)
    if (!bucket) return   // outside the display window — intentionally dropped, see doc comment
    bucket.count++
    const n = parseFloat(String(o[C_VALUE] || '0').replace(/[^0-9.]/g, ''))
    bucket.value += isNaN(n) ? 0 : n
  })

  return years
}

// ── Sub/Prime breakdown ──────────────────────────────────────────────────

/** Counts of Prime vs Sub opportunities. Blank/unset values are excluded. */
export function computeSubPrimeBreakdown(pipeline = []) {
  const counts = {}
  pipeline.forEach((o) => {
    const v = String(o[C_PRIMESUB] || '').trim()
    if (v) counts[v] = (counts[v] || 0) + 1
  })
  return counts
}

// Contract classification breakdown

/** Counts of opportunities grouped by contract classification. Blank values excluded. */
export function computeAwardTypeBreakdown(pipeline = []) {
  const counts = {}
  pipeline.forEach((o) => {
    const v = String(o[C_AWARDTYPE] || '').trim()
    if (v) counts[v] = (counts[v] || 0) + 1
  })
  return counts
}

// ── Contract Vehicle breakdown ───────────────────────────────────────────

/** Counts of opportunities grouped by Contract Vehicle name. Blank values excluded. */
export function computeVehicleBreakdown(pipeline = []) {
  const counts = {}
  pipeline.forEach((o) => {
    const v = String(o[C_VEHICLE] || '').trim()
    if (v) counts[v] = (counts[v] || 0) + 1
  })
  return counts
}

export function computeKPIs(pipeline = [], tasks = []) {
  const today = new Date()
  today.setHours(0, 0, 0, 0)

  const in90Days = new Date(today)
  in90Days.setDate(in90Days.getDate() + 90)

  const total  = pipeline.length
  const closed = pipeline.filter((o) => o[C_PHASE] === 'Contract Awarded').length
  const open   = total - closed

  // Pipeline total value
  const totalValueRaw = pipeline.reduce((sum, o) => {
    const n = parseFloat(String(o[C_VALUE] || '0').replace(/[^0-9.]/g, ''))
    return sum + (isNaN(n) ? 0 : n)
  }, 0)

  const totalValueFormatted = formatCurrency(totalValueRaw)

  // By phase — count and total value
  const byPhase = {}
  const byPhaseValue = {}
  getPhaseOrder().forEach((p) => { byPhase[p] = 0; byPhaseValue[p] = 0 })
  pipeline.forEach((o) => {
    const p = o[C_PHASE]
    if (!p) return
    byPhase[p]      = (byPhase[p] || 0) + 1
    const n = parseFloat(String(o[C_VALUE] || '0').replace(/[^0-9.]/g, ''))
    byPhaseValue[p] = (byPhaseValue[p] || 0) + (isNaN(n) ? 0 : n)
  })

  // Expiring within 90 days (contract end date)
  const expiringCount = pipeline.filter((o) => {
    const d = parseLocalDate(o[C_ENDDATE])
    if (isNaN(d.getTime())) return false
    return d >= today && d <= in90Days
  }).length

  const expiringOpps = pipeline
    .filter((o) => {
      const d = parseLocalDate(o[C_ENDDATE])
      if (isNaN(d.getTime())) return false
      return d >= today && d <= in90Days
    })
    .sort((a, b) => parseLocalDate(a[C_ENDDATE]) - parseLocalDate(b[C_ENDDATE]))

  // Tracked opportunities (Opportunity Outlook === 'Tracking')
  const trackedOpps = pipeline.filter((o) => o[C_OUTLOOK] === 'Tracking')

  // Agency counts (raw, no normalization)
  const agencyCounts = {}
  pipeline.forEach((o) => {
    const ag = o[C_AGENCY]
    if (ag && String(ag).trim()) {
      const key = String(ag).trim()
      agencyCounts[key] = (agencyCounts[key] || 0) + 1
    }
  })

  // Overdue tasks
  const overdueCount = tasks.filter(
    (t) => t.Status !== 'Done' && isOverdue(t.DueDate)
  ).length

  // Top owner by count
  const ownerCount = {}
  pipeline.forEach((o) => {
    const owner = o[C_OWNER]
    if (owner) ownerCount[owner] = (ownerCount[owner] || 0) + 1
  })
  const topOwner = Object.entries(ownerCount)
    .sort((a, b) => b[1] - a[1])[0]?.[0] || '—'

  return {
    total, open, closed,
    totalValueRaw, totalValueFormatted,
    byPhase, byPhaseValue,
    expiringCount, expiringOpps,
    trackedOpps,
    agencyCounts,
    overdueCount, topOwner,
  }
}

// ── Currency formatting ───────────────────────────────────────────────────

export function formatCurrency(value) {
  if (!value || isNaN(value)) return '$0'
  if (value >= 1_000_000_000) return `$${(value / 1_000_000_000).toFixed(2)}B`
  if (value >= 1_000_000)     return `$${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000)         return `$${(value / 1_000).toFixed(0)}K`
  return `$${value.toFixed(0)}`
}
