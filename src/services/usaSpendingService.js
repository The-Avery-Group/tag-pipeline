/**
 * Direct browser client for the public USAspending API.
 *
 * USAspending supports CORS, so this intentionally avoids proxying a large
 * multi-page aggregation through the Cloudflare Worker. That proxy path was
 * intermittently failing before USAspending could return a response.
 */

const BASE = 'https://api.usaspending.gov/api/v2'
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000
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
  const today = new Date()
  const year = today.getUTCFullYear()
  const currentDate = today.toISOString().slice(0, 10)
  // The current calendar or fiscal year is included through today only. This
  // avoids asking USAspending for future dates, which can produce future
  // subaward periods when an award overlaps the requested range.
  return yearType === 'fiscal'
    ? { start_date: `${year - 5}-10-01`, end_date: currentDate }
    : { start_date: `${year - 4}-01-01`, end_date: currentDate }
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
  const recipientNames = new Map()
  const now = new Date(); now.setHours(0, 0, 0, 0)
  const sixMonths = new Date(now); sixMonths.setMonth(sixMonths.getMonth() + 6)
  let totalAwardValue = 0; let expiring = 0
  records.forEach((record) => {
    const amount = money(record['Award Amount'])
    totalAwardValue += amount
    const recipientName = String(record['Recipient Name'] || '').trim()
    if (recipientName) recipientNames.set(recipientName, (recipientNames.get(recipientName) || 0) + 1)
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
    incumbentName: [...recipientNames.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || '',
    totalAwardValue,
    averageAwardValue: records.length ? totalAwardValue / records.length : 0,
    expiring,
    agencies: [...agencies.values()].sort((a, b) => b.count - a.count || b.value - a.value),
    departments: [...departments.values()].sort((a, b) => b.count - a.count || b.value - a.value),
  }
}

async function getSummary(uei, yearType, signal, { forceRefresh = false } = {}) {
  const key = `tag_usaspending_summary:v5:${uei}:${yearType}`
  const cached = forceRefresh ? null : readCache(key)
  if (cached) return { ...cached, cache: 'cache' }
  const filter = filters(uei, yearType)
  const countResponse = await post('/search/spending_by_award_count/', { filters: filter, spending_level: 'awards' }, signal)
  const contractCount = Number(countResponse?.results?.contracts || 0)
  const pages = Math.min(Math.ceil(contractCount / PAGE_SIZE), MAX_AWARD_PAGES)
  const responses = []
  for (let start = 0; start < pages; start += PAGE_CONCURRENCY) {
    const batch = Array.from({ length: Math.min(PAGE_CONCURRENCY, pages - start) }, (_, offset) => post('/search/spending_by_award/', {
      filters: filter,
      fields: ['Award ID', 'Award Amount', 'Recipient Name', 'Awarding Agency', 'Awarding Sub Agency', 'Start Date', 'End Date'],
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

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function isoDate(year, month, day = 1) {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

function endOfMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10)
}

function formatPeriod(item, group, yearType) {
  const periodData = item?.time_period || {}
  const year = String(periodData.calendar_year || periodData.fiscal_year || '')
  const numericYear = Number(year) || 0

  if (group === 'month') {
    const fiscalMonth = Number(periodData.month)
    // USAspending returns monthly and quarterly results as fiscal periods,
    // even where the selected date range is calendar based. Fiscal month 1 is
    // October, so fiscal year 2024 / month 8 is May 2024.
    const calendarMonth = ((fiscalMonth + 8) % 12) + 1
    const calendarYear = numericYear - (fiscalMonth <= 3 ? 1 : 0)
    return {
      key: `month:${numericYear}:${fiscalMonth}`,
      label: yearType === 'fiscal'
        ? `${MONTH_NAMES[calendarMonth - 1] || 'Unknown'} FY${numericYear || ''}`
        : `${MONTH_NAMES[calendarMonth - 1] || 'Unknown'}${calendarYear ? ` ${calendarYear}` : ''}`,
      sortKey: yearType === 'fiscal' ? numericYear * 100 + fiscalMonth : calendarYear * 100 + calendarMonth,
      startDate: isoDate(calendarYear, calendarMonth),
      endDate: endOfMonth(calendarYear, calendarMonth),
    }
  }
  if (group === 'quarter') {
    const fiscalQuarter = Number(periodData.quarter)
    const calendarQuarter = ((fiscalQuarter + 2) % 4) + 1
    const calendarYear = numericYear - (fiscalQuarter === 1 ? 1 : 0)
    const startMonth = [10, 1, 4, 7][fiscalQuarter - 1]
    const startYear = fiscalQuarter === 1 ? numericYear - 1 : numericYear
    const endMonth = [12, 3, 6, 9][fiscalQuarter - 1]
    const endYear = fiscalQuarter === 1 ? numericYear - 1 : numericYear
    return {
      key: `quarter:${numericYear}:${fiscalQuarter}`,
      label: yearType === 'fiscal' ? `Q${fiscalQuarter || ''} FY${numericYear || ''}` : `Q${calendarQuarter || ''} ${calendarYear || ''}`,
      sortKey: yearType === 'fiscal' ? numericYear * 10 + fiscalQuarter : calendarYear * 10 + calendarQuarter,
      startDate: isoDate(startYear, startMonth),
      endDate: endOfMonth(endYear, endMonth),
    }
  }
  const fiscal = Boolean(periodData.fiscal_year)
  return {
    key: `year:${year}`,
    label: fiscal ? `FY${year}` : year || 'Unknown',
    sortKey: numericYear,
    startDate: fiscal ? isoDate(numericYear - 1, 10) : isoDate(numericYear, 1),
    endDate: fiscal ? isoDate(numericYear, 9, 30) : isoDate(numericYear, 12, 31),
  }
}

function isVisiblePeriod(periodInfo, requestedPeriod) {
  return periodInfo.startDate <= requestedPeriod.end_date && periodInfo.endDate >= requestedPeriod.start_date
}

function combineTimeSeries(primeResults, subcontractResults, group, yearType, requestedPeriod) {
  const periods = new Map()
  const add = (results, key) => (results || []).forEach((item) => {
    const periodInfo = formatPeriod(item, group, yearType)
    if (!isVisiblePeriod(periodInfo, requestedPeriod)) return
    const entry = periods.get(periodInfo.key) || { ...periodInfo, value: 0, primeValue: 0, subcontractValue: 0 }
    entry[key] = money(item.aggregated_amount)
    // Keep value for the dashboard's existing prime-only chart.
    entry.value = entry.primeValue
    periods.set(periodInfo.key, entry)
  })
  add(primeResults, 'primeValue')
  add(subcontractResults, 'subcontractValue')
  return [...periods.values()].sort((a, b) => a.sortKey - b.sortKey)
}

export async function getEntityAwardHistory({ uei, yearType = 'calendar', group = 'year', signal, forceRefresh = false, includeSubcontracts = false } = {}) {
  const normalizedUEI = String(uei || '').trim().toUpperCase()
  if (!validUEI(normalizedUEI)) throw new Error('Provide a valid 12-character UEI')
  const resultKey = `tag_usaspending_history:v7:${normalizedUEI}:${yearType}:${group}:${includeSubcontracts ? 'with-subcontracts' : 'prime-only'}`
  const cached = forceRefresh ? null : readCache(resultKey)
  if (cached) return { ...cached, cache: 'cache' }
  const apiGroup = { year: yearType === 'fiscal' ? 'fiscal_year' : 'calendar_year', quarter: 'quarter', month: 'month' }[group] || 'calendar_year'
  const requests = [
    getSummary(normalizedUEI, yearType, signal, { forceRefresh }),
    post('/search/spending_over_time/', { group: apiGroup, filters: filters(normalizedUEI, yearType) }, signal),
  ]
  if (includeSubcontracts) {
    requests.push(post('/search/spending_over_time/', {
      group: apiGroup,
      filters: filters(normalizedUEI, yearType),
      subawards: true,
      spending_level: 'subawards',
    }, signal))
  }
  const results = await Promise.allSettled(requests)
  if (results[0].status === 'rejected') throw results[0].reason
  if (results[1].status === 'rejected') throw results[1].reason
  const summary = results[0].value
  const primeTimeSeries = results[1].value
  const subcontractResult = results[2]
  const subcontractDataAvailable = !includeSubcontracts || subcontractResult?.status === 'fulfilled'
  const subcontractTimeSeries = subcontractResult?.status === 'fulfilled' ? subcontractResult.value : null
  const data = {
    uei: normalizedUEI, yearType, group, period: period(yearType),
    ...summary,
    expiringAwards: summary.expiring,
    series: combineTimeSeries(primeTimeSeries?.results, subcontractTimeSeries?.results, group, yearType, period(yearType)),
    subcontractDataAvailable,
    source: 'USAspending.gov', fetchedAt: new Date().toISOString(),
  }
  writeCache(resultKey, data)
  return data
}
