const USASPENDING_BASE = 'https://api.usaspending.gov/api/v2'
const IDV_CODES = ['IDV_A', 'IDV_B', 'IDV_B_A', 'IDV_B_B', 'IDV_B_C', 'IDV_C', 'IDV_D', 'IDV_E']
const VEHICLE_FIELDS = [
  'Award ID',
  'Recipient Name',
  'Recipient UEI',
  'Awarding Agency',
  'Awarding Agency Code',
  'Awarding Sub Agency',
  'Awarding Sub Agency Code',
  'Description',
  'Last Modified Date',
  'Base Obligation Date',
  'Start Date',
  'Award Amount',
  'Total Outlays',
  'Contract Award Type',
  'Last Date to Order',
  'NAICS',
  'PSC',
  'generated_internal_id',
]
const CACHE_SECONDS = 7 * 24 * 60 * 60
const SEARCH_CACHE_SECONDS = 24 * 60 * 60
const REQUEST_TIMEOUT_MS = 20_000
// Broad IDV searches can legitimately take close to two minutes on
// USAspending. Keep the shorter timeout for autocomplete and detail calls,
// but do not abort a valid vehicle search before the upstream API responds.
const VEHICLE_REQUEST_TIMEOUT_MS = 150_000

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  })
}

function clean(value) {
  return String(value || '').trim()
}

function number(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function normalized(value) {
  return clean(value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\b(the|department|agency|administration|office|bureau|of|and)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

function matchScore(query, agency) {
  const target = normalized(query)
  if (!target) return 0
  const name = normalized(agency.name)
  const parent = normalized(agency.parentName)
  const abbreviation = normalized(agency.abbreviation)
  if (name === target) return 100
  if (abbreviation === target) return 95
  if (name.startsWith(target)) return 80
  if (name.includes(target)) return 70
  if (parent === target) return 60
  const terms = target.split(/\s+/).filter(Boolean)
  return terms.reduce((score, term) => score + (name.includes(term) ? 8 : 0), 0)
}

export function mapAgencyResult(result) {
  const top = result?.toptier_agency || {}
  const sub = result?.subtier_agency || {}
  const tier = result?.toptier_flag ? 'toptier' : 'subtier'
  const name = clean(tier === 'toptier' ? top.name : sub.name)
  return {
    id: result?.id ?? null,
    tier,
    name,
    abbreviation: clean(tier === 'toptier' ? top.abbreviation : sub.abbreviation),
    toptierCode: clean(top.toptier_code),
    parentName: clean(top.name),
    parentAbbreviation: clean(top.abbreviation),
  }
}

export function mapTopTierReference(result) {
  return {
    id: result?.agency_id ?? null,
    tier: 'toptier',
    name: clean(result?.agency_name),
    abbreviation: clean(result?.abbreviation),
    toptierCode: clean(result?.toptier_code),
    parentName: clean(result?.agency_name),
    parentAbbreviation: clean(result?.abbreviation),
  }
}

export function mapVehicleRecord(record) {
  const naics = record?.NAICS || {}
  const psc = record?.PSC || {}
  return {
    awardId: clean(record?.['Award ID']),
    generatedId: clean(record?.generated_internal_id),
    description: clean(record?.Description),
    vehicleType: clean(record?.['Contract Award Type']),
    contractor: clean(record?.['Recipient Name']),
    contractorUEI: clean(record?.['Recipient UEI']),
    awardingAgency: clean(record?.['Awarding Agency']),
    awardingAgencyCode: clean(record?.['Awarding Agency Code']),
    awardingSubAgency: clean(record?.['Awarding Sub Agency']),
    awardingSubAgencyCode: clean(record?.['Awarding Sub Agency Code']),
    awardAmount: number(record?.['Award Amount']),
    totalOutlays: number(record?.['Total Outlays']),
    startDate: clean(record?.['Start Date']),
    lastDateToOrder: clean(record?.['Last Date to Order']),
    lastModifiedDate: clean(record?.['Last Modified Date']),
    baseObligationDate: clean(record?.['Base Obligation Date']),
    naicsCode: clean(naics.code),
    naicsDescription: clean(naics.description),
    pscCode: clean(psc.code),
    pscDescription: clean(psc.description),
  }
}

function mapActivityRecord(record) {
  return {
    awardId: clean(record?.piid),
    generatedId: clean(record?.generated_unique_award_id),
    parentAwardId: clean(record?.parent_award_piid),
    contractor: clean(record?.recipient_name),
    awardingAgency: clean(record?.awarding_agency),
    obligatedAmount: number(record?.obligated_amount),
    potentialValue: number(record?.awarded_amount),
    startDate: clean(record?.period_of_performance_start_date),
    potentialEndDate: clean(record?.period_of_performance_potential_end_date),
    grandchild: Boolean(record?.grandchild),
  }
}

export function summarizeVehicleActivity(amounts = {}, activity = {}) {
  const orders = (activity?.results || []).map(mapActivityRecord)
  const contractorNames = new Set(orders.map((item) => item.contractor).filter(Boolean))
  const directOrderCount = number(amounts.child_award_count)
  const nestedOrderCount = number(amounts.grandchild_award_count)
  return {
    childVehicleCount: number(amounts.child_idv_count),
    directOrderCount,
    nestedOrderCount,
    totalOrderCount: directOrderCount + nestedOrderCount,
    totalObligations: number(amounts.child_award_total_obligation) + number(amounts.grandchild_award_total_obligation),
    totalPotentialValue: number(amounts.child_award_base_and_all_options_value) + number(amounts.grandchild_award_base_and_all_options_value),
    totalExercisedValue: number(amounts.child_award_base_exercised_options_val) + number(amounts.grandchild_award_base_exercised_options_val),
    displayedContractors: contractorNames.size,
    displayedOrders: orders,
    activityTotal: number(activity?.page_metadata?.total),
    activityTruncated: Boolean(activity?.page_metadata?.hasNext),
  }
}

async function fetchUSAspending(path, {
  method = 'GET',
  body,
  attempts = 2,
  timeoutMs = REQUEST_TIMEOUT_MS,
} = {}) {
  let lastError
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetch(`${USASPENDING_BASE}${path}`, {
        method,
        headers: body
          ? { Accept: 'application/json', 'Content-Type': 'application/json' }
          : { Accept: 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      })
      if (response.ok) return response.json()
      lastError = new Error(`USAspending returned ${response.status}`)
      if (![429, 502, 503, 504, 525].includes(response.status)) break
    } catch (error) {
      lastError = error?.name === 'AbortError'
        ? new Error('USAspending request timed out')
        : error
    } finally {
      clearTimeout(timeout)
    }
  }
  throw lastError || new Error('USAspending is temporarily unavailable')
}

function cacheRequest(req, key) {
  const url = new URL(req.url)
  url.pathname = `/__agency_intelligence_cache__/${key}`
  url.search = ''
  return new Request(url.toString(), { method: 'GET' })
}

async function cachedJSON(req, key, seconds, forceRefresh, loader, ctx) {
  const cache = globalThis.caches?.default
  const request = cacheRequest(req, key)
  if (cache && !forceRefresh) {
    const hit = await cache.match(request)
    if (hit) {
      const payload = await hit.json()
      return { ...payload, cache: 'cache' }
    }
  }

  const payload = await loader()
  const response = json({ ...payload, cache: 'live' }, 200, {
    'Cache-Control': `public, max-age=${seconds}`,
  })
  if (cache) {
    const write = cache.put(request, response.clone()).catch((error) => {
      console.warn('[Agency Intelligence] Cache write failed', { key, error: error.message })
    })
    if (ctx?.waitUntil) ctx.waitUntil(write)
    else await write
  }
  return { ...payload, cache: 'live' }
}

function vehicleFilters(agency) {
  const selected = {
    type: 'awarding',
    tier: agency.tier,
    name: agency.name,
  }
  if (agency.tier === 'subtier' && agency.parentName) selected.toptier_name = agency.parentName
  return { agencies: [selected], award_type_codes: IDV_CODES }
}

async function searchAgencies(req, ctx) {
  const url = new URL(req.url)
  const query = clean(url.searchParams.get('q'))
  if (query.length < 2) return json({ agencies: [], query })
  const limit = Math.min(20, Math.max(5, number(url.searchParams.get('limit')) || 12))
  try {
    const payload = await cachedJSON(req, `agency_search:${normalized(query)}:${limit}`, SEARCH_CACHE_SECONDS, false, async () => {
      let response
      let searchSource = 'autocomplete'
      try {
        response = await fetchUSAspending('/autocomplete/awarding_agency/', {
          method: 'POST',
          body: { search_text: query, limit },
        })
      } catch (autocompleteError) {
        console.warn('[Agency Intelligence] Autocomplete unavailable, using top-tier references', {
          query,
          error: autocompleteError.message,
        })
        const references = await fetchUSAspending('/references/toptier_agencies/')
        response = {
          results: (references?.results || [])
            .map(mapTopTierReference)
            .filter((agency) => matchScore(query, agency) > 0)
            .sort((a, b) => matchScore(query, b) - matchScore(query, a) || a.name.localeCompare(b.name))
            .slice(0, limit),
        }
        searchSource = 'top-tier references fallback'
      }
      const seen = new Set()
      const agencies = (response?.results || [])
        .map((result) => result?.tier ? result : mapAgencyResult(result))
        .filter((agency) => {
          const key = `${agency.tier}:${agency.toptierCode}:${normalized(agency.name)}`
          if (!agency.name || seen.has(key)) return false
          seen.add(key)
          return true
        })
        .sort((a, b) => matchScore(query, b) - matchScore(query, a) || a.name.localeCompare(b.name))
      return { agencies, query, fetchedAt: new Date().toISOString(), source: 'USAspending.gov', searchSource }
    }, ctx)
    return json(payload)
  } catch (error) {
    console.error('[Agency Intelligence] Agency search failed', { query, error: error.message })
    return json({ error: 'Agency search is temporarily unavailable' }, 502)
  }
}

async function getVehicles(req, ctx) {
  const url = new URL(req.url)
  const agency = {
    name: clean(url.searchParams.get('name')),
    tier: url.searchParams.get('tier') === 'subtier' ? 'subtier' : 'toptier',
    parentName: clean(url.searchParams.get('parent')),
    toptierCode: clean(url.searchParams.get('code')),
  }
  if (!agency.name) return json({ error: 'Agency name is required' }, 400)
  const page = Math.max(1, number(url.searchParams.get('page')) || 1)
  const limit = Math.min(100, Math.max(10, number(url.searchParams.get('limit')) || 50))
  const forceRefresh = url.searchParams.get('refresh') === '1'
  const key = `vehicles:${agency.tier}:${normalized(agency.parentName)}:${normalized(agency.name)}:${page}:${limit}`

  try {
    const payload = await cachedJSON(req, key, CACHE_SECONDS, forceRefresh, async () => {
      const filters = vehicleFilters(agency)
      const [countResult, vehiclesResult] = await Promise.allSettled([
        fetchUSAspending('/search/spending_by_award_count/', {
          method: 'POST',
          body: { filters, spending_level: 'awards', subawards: false },
          attempts: 1,
          timeoutMs: VEHICLE_REQUEST_TIMEOUT_MS,
        }),
        fetchUSAspending('/search/spending_by_award/', {
          method: 'POST',
          body: {
            filters,
            fields: VEHICLE_FIELDS,
            page,
            limit,
            sort: 'Last Modified Date',
            order: 'desc',
            subawards: false,
          },
          attempts: 1,
          timeoutMs: VEHICLE_REQUEST_TIMEOUT_MS,
        }),
      ])
      if (vehiclesResult.status === 'rejected') throw vehiclesResult.reason
      const resultResponse = vehiclesResult.value
      const countResponse = countResult.status === 'fulfilled' ? countResult.value : null
      if (countResult.status === 'rejected') {
        console.warn('[Agency Intelligence] Vehicle count unavailable; returning vehicle rows', {
          agency: agency.name,
          error: countResult.reason?.message || 'Unknown error',
        })
      }
      const vehicles = (resultResponse?.results || []).map(mapVehicleRecord)
      return {
        agency,
        vehicles,
        totalVehicles: countResponse ? number(countResponse?.results?.idvs) : null,
        page,
        limit,
        hasNext: Boolean(resultResponse?.page_metadata?.hasNext),
        fetchedAt: new Date().toISOString(),
        source: 'USAspending.gov',
      }
    }, ctx)
    return json(payload)
  } catch (error) {
    console.error('[Agency Intelligence] Vehicle lookup failed', { agency: agency.name, page, error: error.message })
    const timedOut = /timed out/i.test(error?.message || '')
    return json({
      error: timedOut
        ? 'USAspending took too long to return vehicle data. Please try again.'
        : 'Vehicle data is temporarily unavailable',
      code: timedOut ? 'USASPENDING_TIMEOUT' : 'USASPENDING_UNAVAILABLE',
    }, 502)
  }
}

async function getVehicleDetail(req, ctx) {
  const url = new URL(req.url)
  const awardId = clean(url.searchParams.get('awardId'))
  if (!/^CONT_IDV_[A-Z0-9_-]+$/i.test(awardId)) return json({ error: 'A valid USAspending vehicle identifier is required' }, 400)
  const forceRefresh = url.searchParams.get('refresh') === '1'
  const key = `vehicle_detail:${awardId}`

  try {
    const payload = await cachedJSON(req, key, CACHE_SECONDS, forceRefresh, async () => {
      const [amounts, activity] = await Promise.all([
        fetchUSAspending(`/idvs/amounts/${encodeURIComponent(awardId)}/`),
        fetchUSAspending('/idvs/activity/', {
          method: 'POST',
          body: { award_id: awardId, page: 1, limit: 50, hide_edge_cases: false },
        }),
      ])
      return {
        awardId,
        ...summarizeVehicleActivity(amounts, activity),
        fetchedAt: new Date().toISOString(),
        source: 'USAspending.gov',
      }
    }, ctx)
    return json(payload)
  } catch (error) {
    console.error('[Agency Intelligence] Vehicle detail failed', { awardId, error: error.message })
    return json({ error: 'Vehicle activity is temporarily unavailable' }, 502)
  }
}

export async function handleAgencyIntelligence(req, ctx) {
  const path = new URL(req.url).pathname
  if (path === '/agency-intelligence/agencies' && req.method === 'GET') return searchAgencies(req, ctx)
  if (path === '/agency-intelligence/vehicles' && req.method === 'GET') return getVehicles(req, ctx)
  if (path === '/agency-intelligence/vehicle' && req.method === 'GET') return getVehicleDetail(req, ctx)
  return json({ error: 'Not found' }, 404)
}
