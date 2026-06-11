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
  return ['Research', 'Indentified', 'Contract Awarded']
}

// ── KPI computation ───────────────────────────────────────────────────────

const C_PHASE  = 'TAG Opportunity Phase'
const C_VALUE  = 'Total Contract Value ($)*'
const C_OWNER  = 'Assigned To*'
const C_LASTMOD = 'Last Modified*'

export function computeKPIs(pipeline = [], tasks = []) {
  const total  = pipeline.length
  const closed = pipeline.filter((o) => o[C_PHASE] === 'Contract Awarded').length
  const open   = total - closed

  // Pipeline total value
  const totalValueRaw = pipeline.reduce((sum, o) => {
    const n = parseFloat(String(o[C_VALUE] || '0').replace(/[^0-9.]/g, ''))
    return sum + (isNaN(n) ? 0 : n)
  }, 0)

  const totalValueFormatted = formatCurrency(totalValueRaw)

  // By phase
  const byPhase = {}
  getPhaseOrder().forEach((p) => { byPhase[p] = 0 })
  pipeline.forEach((o) => {
    const p = o[C_PHASE]
    if (p) byPhase[p] = (byPhase[p] || 0) + 1
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
    byPhase, overdueCount, topOwner,
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