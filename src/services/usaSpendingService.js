/**
 * Direct browser client for the public USAspending API.
 *
 * USAspending supports CORS, so this intentionally avoids proxying a large
 * multi-page aggregation through the Cloudflare Worker. That proxy path was
 * intermittently failing before USAspending could return a response.
 */

const BASE = 'https://api.usaspending.gov/api/v2'
const CACHE_TTL_MS = 6 * 60 * 60 * 1000
const CONTRACT_CODES = ['A', 'B', 'C', 'D']
const PAGE_SIZE = 100
const MAX_AWARD_PAGES = 20
const PAGE_CONCURRENCY = 3
const REQUEST_TIMEOUT_MS = 15_000

function validUEI(value) { return /^[A-Z0-9]{12}$/.test(String(value || '').trim().toUpperCase()) }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)) }

function readCache(key) {
  try {
    const value = JSON.parse(localStorage.getItem(key) || 'null')
    return value?.expiresAt > Date.now() ? value.data : null
  } catch { return null }
}

function writeCache(key, data) {
  try { localStorage.setItem(key, JSON.stringify({ expiresAt: Date.now() + CACHE_TTL_MS, data })) } catch {}
}

function period(yearType) {
  const year = new Date().getUTCFullYear()
  return yearType === 'fiscal'
    ? { start_date: `${year - 5}-10-01`, end_date: `${year}-09-30` }
    : { start_date: `${year - 4}-01-01`, end_date: `${year}-12-31` }
}

function filters(uei, yearType) {
  return { time_period: [period(yearType)], recipient_search_text: [uei], award_type_codes: CONTRACT_CODES }
}

async function post(path, body, signal, attempts = 3) {
  let lastStatus = null
  for (let attempt = 0; attempt < attempts; attempt++) {
    const controller = new AbortController()
    const forwardAbort = () => controller.abort(signal?.reason || 'Request cancelled')
    signal?.addEventListener('abort', forwardAbort, { once: true })
    const timeout = setTimeout(() => controller.abort('USAspending request timed out'), REQUEST_TIMEOUT_MS)
    try {
      const response = await fetch(`${BASE}${path}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: controller.signal,
      })
      if (response.ok) return response.json()
      lastStatus = response.status
      if (![429, 502, 503, 504, 525].includes(response.status) || attempt === attempts - 1) break
    } catch (error) {
      if (signal?.aborted) throw new DOMException('Request cancelled', 'AbortError')
      if (attempt === attempts - 1) throw new Error('USAspending is temporarily unavailable. Please try again.')
    } finally {
      clearTimeout(timeout)
      signal?.removeEventListener('abort', forwardAbort)
    }
    await sleep(300 * (attempt + 1))
  }
  throw new Error(lastStatus === 525 ? 'USAspending is temporarily unavailable. Please try again.' : `USAspending API error ${lastStatus || 'unavailable'}`)
}

function money(value) { return Number(value || 0) }

function summarize(records) {
  const agencies = new Map()
  const departments = new Map()
  const now = new Date(); now.setHours(0, 0, 0, 0)
  const sixMonths = new Date(now); sixMonths.setMonth(sixMonths.getMonth() + 6)
  let totalAwardValue = 0; let expiring = 0
  records.forEach((record) => {
    const amount = money(record['Award Amount'])
    totalAwardValue += amount
    const name = record['Awarding Sub Agency'] || record['Awarding Agency'] || 'Unknown agency'
    const departmentName = record['Awarding Agency'] || 'Unknown department'
    const agency = agencies.get(name) || { name, count: 0, value: 0 }
    agency.count++; agency.value += amount; agencies.set(name, agency)
    const department = departments.get(departmentName) || { name: departmentName, count: 0, value: 0 }
    department.count++; department.value += amount; departments.set(departmentName, department)
    const end = new Date(record['End Date'])
    if (!Number.isNaN(end.getTime()) && end >= now && end <= sixMonths) expiring++
  })
  return {
    totalAwardValue,
    averageAwardValue: records.length ? totalAwardValue / records.length : 0,
    expiring,
    agencies: [...agencies.values()].sort((a, b) => b.count - a.count || b.value - a.value),
    departments: [...departments.values()].sort((a, b) => b.count - a.count || b.value - a.value),
  }
}

async function getSummary(uei, yearType, signal) {
  const key = `tag_usaspending_summary:v3:${uei}:${yearType}`
  const cached = readCache(key)
  if (cached) return { ...cached, cache: 'cache' }
  const filter = filters(uei, yearType)
  const countResponse = await post('/search/spending_by_award_count/', { filters: filter, spending_level: 'awards' }, signal)
  const contractCount = Number(countResponse?.results?.contracts || 0)
  const pages = Math.min(Math.ceil(contractCount / PAGE_SIZE), MAX_AWARD_PAGES)
  const responses = []
  for (let start = 0; start < pages; start += PAGE_CONCURRENCY) {
    const batch = Array.from({ length: Math.min(PAGE_CONCURRENCY, pages - start) }, (_, offset) => post('/search/spending_by_award/', {
      filters: filter,
      fields: ['Award ID', 'Award Amount', 'Awarding Agency', 'Awarding Sub Agency', 'Start Date', 'End Date'],
      page: start + offset + 1, limit: PAGE_SIZE, sort: 'Award Amount', order: 'desc', subawards: false,
    }, signal))
    responses.push(...await Promise.all(batch))
  }
  const records = responses.flatMap((response) => response.results || [])
  const data = {
    contractCount,
    displayedAwardCount: records.length,
    truncated: pages < Math.ceil(contractCount / PAGE_SIZE),
    ...summarize(records),
  }
  writeCache(key, data)
  return { ...data, cache: 'live' }
}

export async function getEntityAwardHistory({ uei, yearType = 'calendar', group = 'year', signal } = {}) {
  const normalizedUEI = String(uei || '').trim().toUpperCase()
  if (!validUEI(normalizedUEI)) throw new Error('Provide a valid 12-character UEI')
  const resultKey = `tag_usaspending_history:v4:${normalizedUEI}:${yearType}:${group}`
  const cached = readCache(resultKey)
  if (cached) return { ...cached, cache: 'cache' }
  const apiGroup = { year: yearType === 'fiscal' ? 'fiscal_year' : 'calendar_year', quarter: 'quarter', month: 'month' }[group] || 'calendar_year'
  const [summary, timeSeries] = await Promise.all([
    getSummary(normalizedUEI, yearType, signal),
    post('/search/spending_over_time/', { group: apiGroup, filters: filters(normalizedUEI, yearType) }, signal),
  ])
  const data = {
    uei: normalizedUEI, yearType, group, period: period(yearType),
    ...summary,
    expiringAwards: summary.expiring,
    series: (timeSeries?.results || []).map((item) => ({
      label: Object.values(item.time_period || {}).filter(Boolean).join(' '),
      value: money(item.aggregated_amount),
    })),
    source: 'USAspending.gov', fetchedAt: new Date().toISOString(),
  }
  writeCache(resultKey, data)
  return data
}
