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
const CACHE_SECONDS = 30 * 24 * 60 * 60
const SEARCH_CACHE_SECONDS = 24 * 60 * 60
const AGENCY_CROSSWALK_SECONDS = 30 * 24 * 60 * 60
const REQUEST_TIMEOUT_MS = 20_000
// Broad IDV searches can legitimately take close to two minutes on
// USAspending. Keep the shorter timeout for autocomplete and detail calls,
// but do not abort a valid vehicle search before the upstream API responds.
const VEHICLE_REQUEST_TIMEOUT_MS = 150_000
const USAGE_REQUEST_TIMEOUT_MS = 45_000
const USAGE_CACHE_SECONDS = 30 * 24 * 60 * 60

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

function identity(value) {
  return clean(value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\bdept\b/g, 'department')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\bthe\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function samTopTierCode(departmentId) {
  const value = clean(departmentId)
  if (!/^\d{4}$/.test(value) || !value.endsWith('00')) return ''
  return value.slice(0, 2).padStart(3, '0')
}

function agencyCrosswalkKey(candidate = {}) {
  const departmentId = clean(candidate.departmentId)
  const agencyId = clean(candidate.agencyId)
  return departmentId && agencyId ? `agency_crosswalk:v1:${departmentId}:${agencyId}` : ''
}

function pipelineAgencyTerms(candidate = {}) {
  const name = clean(candidate.name)
  const withoutParenthetical = name.replace(/\s*\([^)]*\)\s*/g, ' ').replace(/\s+/g, ' ').trim()
  const parenthetical = [...name.matchAll(/\(([^)]+)\)/g)].map((match) => clean(match[1]))
  return [...new Set([name, withoutParenthetical, ...parenthetical].filter(Boolean))]
}

function exactAgencyMatch(candidate, agencies = []) {
  const aliases = pipelineAgencyTerms(candidate).map(identity)
  const parent = identity(candidate.parentName)
  const isSubtier = parent && !aliases.includes(parent)
  return agencies.find((agency) => {
    if (isSubtier && agency.tier !== 'subtier') return false
    if (!isSubtier && agency.tier !== 'toptier') return false
    if (isSubtier && parent && identity(agency.parentName) !== parent) return false
    return aliases.includes(identity(agency.name)) || aliases.includes(identity(agency.abbreviation))
  }) || null
}

export function agencyUsageKey(agency, scope = 'funding') {
  const type = scope === 'awarding' ? 'awarding' : 'funding'
  return `agency_vehicle_usage:v4:${type}:${agency?.tier === 'subtier' ? 'subtier' : 'toptier'}:${normalized(agency?.parentName)}:${normalized(agency?.name)}`
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

function mapSubagencyReference(result, parent, toptierCode) {
  return {
    id: null,
    tier: 'subtier',
    name: clean(result?.name),
    abbreviation: clean(result?.abbreviation),
    toptierCode: clean(toptierCode),
    parentName: clean(parent?.name),
    parentAbbreviation: clean(parent?.abbreviation),
  }
}

async function resolveAgencyCandidate(candidate) {
  const topCode = samTopTierCode(candidate.departmentId)
  let topAgencies = []
  if (topCode) {
    try {
      const references = await fetchUSAspending('/references/toptier_agencies/')
      topAgencies = (references?.results || []).map(mapTopTierReference)
      const exactTop = topAgencies.find((agency) => agency.toptierCode === topCode)
      const isTopTier = !candidate.parentName || identity(candidate.name) === identity(candidate.parentName) || clean(candidate.agencyId) === clean(candidate.departmentId)
      if (exactTop && isTopTier) return exactTop
    } catch (error) {
      console.warn('[Agency Intelligence] Top-tier agency references unavailable during resolution', {
        departmentId: candidate.departmentId,
        error: error.message,
      })
    }
  }

  const autocompleteMatches = []
  const seen = new Set()
  for (const term of pipelineAgencyTerms(candidate)) {
    try {
      const response = await fetchUSAspending('/autocomplete/awarding_agency/', {
        method: 'POST',
        body: { search_text: term, limit: 20 },
      })
      for (const result of response?.results || []) {
        const agency = mapAgencyResult(result)
        const key = `${agency.tier}:${agency.id}:${identity(agency.name)}`
        if (!seen.has(key)) { seen.add(key); autocompleteMatches.push(agency) }
      }
    } catch (error) {
      console.warn('[Agency Intelligence] Agency autocomplete term failed during resolution', {
        term,
        error: error.message,
      })
    }
  }
  const autocompleteMatch = exactAgencyMatch(candidate, autocompleteMatches)
  if (autocompleteMatch) return autocompleteMatch

  if (topCode) {
    const parent = topAgencies.find((agency) => agency.toptierCode === topCode) || {
      name: candidate.parentName,
      abbreviation: '',
    }
    const now = new Date()
    const fiscalYear = now.getUTCMonth() >= 9 ? now.getUTCFullYear() + 1 : now.getUTCFullYear()
    try {
      const response = await fetchUSAspending(`/agency/${encodeURIComponent(topCode)}/sub_agency/?fiscal_year=${fiscalYear}&page=1&limit=100`)
      const subagencies = (response?.results || []).map((result) => mapSubagencyReference(result, parent, topCode))
      const referenceMatch = exactAgencyMatch(candidate, subagencies)
      if (referenceMatch) return referenceMatch
    } catch (error) {
      console.warn('[Agency Intelligence] Sub-agency references unavailable during resolution', {
        departmentId: candidate.departmentId,
        agencyId: candidate.agencyId,
        error: error.message,
      })
    }
  }
  return null
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

export async function fetchUSAspending(path, {
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
      const upstreamError = new Error(`USAspending returned ${response.status}`)
      upstreamError.status = response.status
      lastError = upstreamError
      await response.body?.cancel().catch(() => {})
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

function candidateFromSearchParams(url) {
  return {
    name: clean(url.searchParams.get('name')),
    parentName: clean(url.searchParams.get('parent')),
    departmentId: clean(url.searchParams.get('departmentId')),
    agencyId: clean(url.searchParams.get('agencyId')),
  }
}

function validAgencyMapping(agency) {
  return agency && ['toptier', 'subtier'].includes(agency.tier) && clean(agency.name)
}

async function resolveAgency(req, env) {
  if (!env?.CACHE) return json({ error: 'Agency crosswalk cache is not configured' }, 503)

  if (req.method === 'POST') {
    const body = await req.json().catch(() => ({}))
    const candidate = body?.candidate || {}
    const agency = body?.agency || null
    const key = agencyCrosswalkKey(candidate)
    if (!key) return json({ error: 'SAM Department ID and Agency ID are required to remember a match' }, 400)
    if (!validAgencyMapping(agency)) return json({ error: 'A valid official USAspending agency is required' }, 400)
    const stored = {
      ...agency,
      samDepartmentId: clean(candidate.departmentId),
      samAgencyId: clean(candidate.agencyId),
      matchedAt: new Date().toISOString(),
      matchSource: 'confirmed',
    }
    await env.CACHE.put(key, JSON.stringify(stored), { expirationTtl: AGENCY_CROSSWALK_SECONDS })
    return json({ agency: stored, cache: 'saved' })
  }

  const url = new URL(req.url)
  const candidate = candidateFromSearchParams(url)
  if (!candidate.name) return json({ error: 'Agency name is required' }, 400)
  const key = agencyCrosswalkKey(candidate)
  if (key) {
    const remembered = await env.CACHE.get(key, 'json')
    if (validAgencyMapping(remembered)) return json({ agency: remembered, cache: 'crosswalk' })
  }

  const agency = await resolveAgencyCandidate(candidate)
  if (!agency) return json({ agency: null, cache: 'miss' })
  const resolved = {
    ...agency,
    samDepartmentId: candidate.departmentId,
    samAgencyId: candidate.agencyId,
    matchedAt: new Date().toISOString(),
    matchSource: 'official',
  }
  if (key) await env.CACHE.put(key, JSON.stringify(resolved), { expirationTtl: AGENCY_CROSSWALK_SECONDS })
  return json({ agency: resolved, cache: 'resolved' })
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
    console.error(JSON.stringify({
      event: 'agency_vehicle_lookup_failed',
      agency: agency.name,
      agencyTier: agency.tier,
      parentAgency: agency.parentName,
      page,
      upstreamStatus: error?.status || null,
      message: error?.message || 'Unknown error',
    }))
    const timedOut = /timed out/i.test(error?.message || '')
    const upstreamStatus = Number(error?.status) || null
    return json({
      error: timedOut
        ? 'USAspending took too long to return vehicle data. Please try again.'
        : 'Vehicle data is temporarily unavailable',
      code: timedOut ? 'USASPENDING_TIMEOUT' : upstreamStatus ? `USASPENDING_${upstreamStatus}` : 'USASPENDING_UNAVAILABLE',
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
      const amounts = await fetchUSAspending(`/idvs/amounts/${encodeURIComponent(awardId)}/`, {
        attempts: 2,
        timeoutMs: USAGE_REQUEST_TIMEOUT_MS,
      })
      const reportedOrders = number(amounts?.child_award_count) + number(amounts?.grandchild_award_count)
      let activity = { results: [], page_metadata: { total: reportedOrders, hasNext: false } }
      let warning = ''
      if (reportedOrders > 0) {
        try {
          activity = await fetchUSAspending('/idvs/activity/', {
            method: 'POST',
            body: { award_id: awardId, page: 1, limit: 50, hide_edge_cases: false },
            attempts: 2,
            timeoutMs: USAGE_REQUEST_TIMEOUT_MS,
          })
        } catch (error) {
          warning = 'Order totals are available, but USAspending could not return the individual order list.'
          console.warn(JSON.stringify({
            event: 'agency_vehicle_activity_partial',
            awardId,
            message: error?.message || 'Unknown error',
          }))
        }
      }
      return {
        awardId,
        ...summarizeVehicleActivity(amounts, activity),
        warning,
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

function usageRequest(req) {
  const url = new URL(req.url)
  return {
    agency: {
      name: clean(url.searchParams.get('name')),
      tier: url.searchParams.get('tier') === 'subtier' ? 'subtier' : 'toptier',
      parentName: clean(url.searchParams.get('parent')),
      toptierCode: clean(url.searchParams.get('code')),
    },
    scope: url.searchParams.get('scope') === 'awarding' ? 'awarding' : 'funding',
    forceRefresh: url.searchParams.get('refresh') === '1',
  }
}

async function getAgencyUsage(req, env) {
  const { agency, scope } = usageRequest(req)
  if (!agency.name) return json({ error: 'Agency name is required' }, 400)
  if (!env?.CACHE) return json({ error: 'Agency vehicle usage cache is not configured' }, 503)
  const key = agencyUsageKey(agency, scope)
  const result = await env.CACHE.get(key, 'json')
  return json(result
    ? { status: 'ready', result, cache: 'shared' }
    : { status: 'miss', cache: 'shared' })
}

function sanitizeUsageVehicle(vehicle = {}) {
  const parentAwardId = clean(vehicle.parentAwardId).toUpperCase().slice(0, 180)
  if (!parentAwardId) return null
  return {
    parentAwardId,
    vehicleName: clean(vehicle.vehicleName).slice(0, 1000),
    vehicleType: clean(vehicle.vehicleType).slice(0, 250),
    generatedId: clean(vehicle.generatedId).slice(0, 300),
    ceiling: number(vehicle.ceiling),
    lastDateToOrder: clean(vehicle.lastDateToOrder).slice(0, 50),
    orders: Math.max(0, Math.trunc(number(vehicle.orders))),
    contractors: Math.max(0, Math.trunc(number(vehicle.contractors))),
    obligations: number(vehicle.obligations),
    lastUsed: clean(vehicle.lastUsed).slice(0, 50),
    topNaics: clean(vehicle.topNaics).slice(0, 30),
    topPsc: clean(vehicle.topPsc).slice(0, 30),
    sampleOrders: (Array.isArray(vehicle.sampleOrders) ? vehicle.sampleOrders : []).slice(0, 8).map((order) => ({
      awardId: clean(order?.awardId).slice(0, 180),
      generatedId: clean(order?.generatedId).slice(0, 300),
      contractor: clean(order?.contractor).slice(0, 500),
      obligation: number(order?.obligation),
      signedDate: clean(order?.signedDate).slice(0, 50),
      description: clean(order?.description).slice(0, 1000),
    })),
  }
}

function sanitizeUsageResult(result, agency, scope) {
  if (!result || typeof result !== 'object' || !Array.isArray(result.vehicles)) {
    throw new Error('A completed vehicle usage result is required')
  }
  if (result.vehicles.length > 50_000) throw new Error('Vehicle usage result is too large')
  if (identity(result?.agency?.name) !== identity(agency.name)) {
    throw new Error('Vehicle usage agency does not match the cache request')
  }
  if ((result.scope === 'awarding' ? 'awarding' : 'funding') !== scope) {
    throw new Error('Vehicle usage scope does not match the cache request')
  }

  const vehicles = result.vehicles.map(sanitizeUsageVehicle).filter(Boolean)
  const totals = {
    vehicles: vehicles.length,
    orders: vehicles.reduce((sum, vehicle) => sum + vehicle.orders, 0),
    contractors: Math.max(0, Math.trunc(number(result?.totals?.contractors))),
    obligations: vehicles.reduce((sum, vehicle) => sum + vehicle.obligations, 0),
  }
  return {
    agency: {
      name: agency.name,
      tier: agency.tier,
      parentName: agency.parentName,
      toptierCode: agency.toptierCode,
    },
    scope,
    period: {
      firstFiscalYear: Math.trunc(number(result?.period?.firstFiscalYear)),
      lastFiscalYear: Math.trunc(number(result?.period?.lastFiscalYear)),
      startDate: clean(result?.period?.startDate).slice(0, 20),
      endDate: clean(result?.period?.endDate).slice(0, 20),
    },
    vehicles,
    totals,
    processedOrders: Math.max(totals.orders, Math.trunc(number(result.processedOrders))),
    unlinkedOrders: Math.max(0, Math.trunc(number(result.unlinkedOrders))),
    fetchedAt: clean(result.fetchedAt).slice(0, 50) || new Date().toISOString(),
    source: 'USAspending.gov',
    transport: 'browser',
  }
}

async function saveAgencyUsage(req, env) {
  const { agency, scope } = usageRequest(req)
  if (!agency.name) return json({ error: 'Agency name is required' }, 400)
  if (!env?.CACHE) return json({ error: 'Agency vehicle usage cache is not configured' }, 503)
  const contentLength = Number(req.headers.get('content-length') || 0)
  if (contentLength > 20_000_000) return json({ error: 'Vehicle usage result is too large' }, 413)
  try {
    const body = await req.json()
    const result = sanitizeUsageResult(body?.result, agency, scope)
    const serialized = JSON.stringify(result)
    if (new TextEncoder().encode(serialized).byteLength > 20_000_000) {
      return json({ error: 'Vehicle usage result is too large' }, 413)
    }
    await env.CACHE.put(agencyUsageKey(agency, scope), serialized, { expirationTtl: USAGE_CACHE_SECONDS })
    return json({ status: 'saved', fetchedAt: result.fetchedAt })
  } catch (error) {
    return json({ error: error?.message || 'Vehicle usage result is invalid' }, 400)
  }
}

async function getAgencyUsageStatus(req, env) {
  // Compatibility for older frontend bundles. Status polling no longer starts
  // or advances work, and simply reads the shared completed-result cache.
  return getAgencyUsage(req, env)
}

export async function handleAgencyIntelligence(req, env, ctx) {
  const path = new URL(req.url).pathname
  if (path === '/agency-intelligence/agencies' && req.method === 'GET') return searchAgencies(req, ctx)
  if (path === '/agency-intelligence/resolve' && ['GET', 'POST'].includes(req.method)) return resolveAgency(req, env)
  if (path === '/agency-intelligence/usage' && req.method === 'GET') return getAgencyUsage(req, env)
  if (path === '/agency-intelligence/usage' && req.method === 'POST') return saveAgencyUsage(req, env)
  if (path === '/agency-intelligence/usage/status' && req.method === 'GET') return getAgencyUsageStatus(req, env)
  if (path === '/agency-intelligence/vehicles' && req.method === 'GET') return getVehicles(req, ctx)
  if (path === '/agency-intelligence/vehicle' && req.method === 'GET') return getVehicleDetail(req, ctx)
  return json({ error: 'Not found' }, 404)
}
