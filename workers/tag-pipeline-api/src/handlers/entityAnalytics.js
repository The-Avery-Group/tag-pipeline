/** USAspending-backed, read-only award history for a single entity UEI. */

const BASE = 'https://api.usaspending.gov/api/v2'
const CACHE_TTL = 6 * 60 * 60
const CONTRACT_CODES = ['A', 'B', 'C', 'D']
const PAGE_SIZE = 100
const MAX_AWARD_PAGES = 20
const AWARD_PAGE_CONCURRENCY = 3
const UPSTREAM_TIMEOUT_MS = 12_000

function json(data, status = 200) { return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } }) }
function validUEI(uei) { return /^[A-Z0-9]{12}$/.test(String(uei || '').trim().toUpperCase()) }

function period(yearType) {
  const now = new Date()
  const year = now.getUTCFullYear()
  if (yearType === 'fiscal') return { start_date: `${year - 5}-10-01`, end_date: `${year}-09-30` }
  return { start_date: `${year - 4}-01-01`, end_date: `${year}-12-31` }
}

function filters(uei, yearType) {
  return { time_period: [period(yearType)], recipient_search_text: [uei], award_type_codes: CONTRACT_CODES }
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)) }

async function post(path, body, { attempts = 3 } = {}) {
  let lastStatus = null
  for (let attempt = 0; attempt < attempts; attempt++) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort('USAspending request timed out'), UPSTREAM_TIMEOUT_MS)
    try {
      const response = await fetch(`${BASE}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: controller.signal })
      if (response.ok) return response.json()
      lastStatus = response.status
      // A 525 is an upstream TLS handshake error. 429 and 5xx responses are
      // similarly transient, so retry them with a short bounded backoff.
      if (![429, 502, 503, 504, 525].includes(response.status) || attempt === attempts - 1) break
    } catch (error) {
      if (attempt === attempts - 1) {
        if (controller.signal.aborted) throw new Error('USAspending did not respond in time. Please try again.')
        throw error
      }
    } finally {
      clearTimeout(timeout)
    }
    await sleep(350 * (attempt + 1))
  }
  if (lastStatus === 525) throw new Error('USAspending is temporarily unavailable. Please try again.')
  throw new Error(`USAspending API error ${lastStatus || 'unavailable'}`)
}

async function awardRecords(filter, count) {
  const pages = Math.min(Math.ceil(Number(count || 0) / PAGE_SIZE), MAX_AWARD_PAGES)
  const pagesData = []
  // Avoid opening twenty external TLS connections at once. USAspending is
  // more reliable when a large entity history is fetched in small groups.
  for (let start = 0; start < pages; start += AWARD_PAGE_CONCURRENCY) {
    const requests = Array.from({ length: Math.min(AWARD_PAGE_CONCURRENCY, pages - start) }, (_, offset) => post('/search/spending_by_award/', {
      filters: filter,
      fields: ['Award ID', 'Award Amount', 'Awarding Agency', 'Start Date', 'End Date'],
      page: start + offset + 1, limit: PAGE_SIZE, sort: 'Award Amount', order: 'desc', subawards: false,
    }))
    pagesData.push(...await Promise.all(requests))
  }
  return { records: pagesData.flatMap((page) => page.results || []), truncated: pages < Math.ceil(Number(count || 0) / PAGE_SIZE) }
}

function money(value) { return Number(value || 0) }

function summarizeAwards(records) {
  const agencies = new Map()
  let totalAwardValue = 0
  let expiring = 0
  const now = new Date(); now.setUTCHours(0, 0, 0, 0)
  const sixMonths = new Date(now); sixMonths.setUTCMonth(sixMonths.getUTCMonth() + 6)
  for (const record of records) {
    const amount = money(record['Award Amount'])
    totalAwardValue += amount
    const agency = record['Awarding Agency'] || 'Unknown agency'
    const current = agencies.get(agency) || { name: agency, count: 0, value: 0 }
    current.count++; current.value += amount; agencies.set(agency, current)
    const end = new Date(record['End Date'])
    if (!Number.isNaN(end.getTime()) && end >= now && end <= sixMonths) expiring++
  }
  return {
    totalAwardValue,
    averageAwardValue: records.length ? totalAwardValue / records.length : 0,
    expiring,
    agencies: [...agencies.values()].sort((a, b) => b.count - a.count || b.value - a.value),
  }
}

export async function handleEntityAnalytics(req, env) {
  const url = new URL(req.url)
  const uei = String(url.searchParams.get('uei') || '').trim().toUpperCase()
  const yearType = url.searchParams.get('yearType') === 'fiscal' ? 'fiscal' : 'calendar'
  const groupParam = url.searchParams.get('group') || 'year'
  const group = { year: yearType === 'fiscal' ? 'fiscal_year' : 'calendar_year', quarter: 'quarter', month: 'month' }[groupParam] || 'calendar_year'
  if (!validUEI(uei)) return json({ error: 'Provide a valid 12-character UEI' }, 400)

  const cacheKey = `entity_award_history:v2:${uei}:${yearType}:${groupParam}`
  const summaryCacheKey = `entity_award_summary:v1:${uei}:${yearType}`
  const cached = await env.CACHE?.get(cacheKey, 'json')
  if (cached) return json({ ...cached, cache: 'cache' })

  try {
    const filter = filters(uei, yearType)
    const [cachedSummary, timeSeries] = await Promise.all([
      env.CACHE?.get(summaryCacheKey, 'json'),
      post('/search/spending_over_time/', { group, filters: filter }),
    ])
    let summaryData = cachedSummary
    if (!summaryData) {
      const countResponse = await post('/search/spending_by_award_count/', { filters: filter, spending_level: 'awards' })
      const contractCount = Number(countResponse?.results?.contracts || 0)
      const { records, truncated } = await awardRecords(filter, contractCount)
      summaryData = { contractCount, displayedAwardCount: records.length, truncated, ...summarizeAwards(records) }
      await env.CACHE?.put(summaryCacheKey, JSON.stringify(summaryData), { expirationTtl: CACHE_TTL })
    }
    const result = {
      uei, yearType, group: groupParam, period: period(yearType),
      ...summaryData,
      expiringAwards: summaryData.expiring,
      series: (timeSeries?.results || []).map((item) => ({
        label: Object.values(item.time_period || {}).filter(Boolean).join(' '),
        value: money(item.aggregated_amount),
      })),
      // Values below are award amounts within the chosen five-year window.
      source: 'USAspending.gov',
      fetchedAt: new Date().toISOString(),
    }
    await env.CACHE?.put(cacheKey, JSON.stringify(result), { expirationTtl: CACHE_TTL })
    return json({ ...result, cache: 'live' })
  } catch (error) {
    console.error('[Entity analytics]', error.message)
    return json({ error: error.message }, 502)
  }
}
