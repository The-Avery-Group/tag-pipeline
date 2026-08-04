import { workerJson } from './workerClient.js'
import { mapOfficialAgencyResults } from '@/lib/agencyIntelligence'

const USASPENDING_BASE = 'https://api.usaspending.gov/api/v2'
const USASPENDING_AGENCY_SEARCH = 'https://api.usaspending.gov/api/v2/autocomplete/awarding_agency/'
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
const agencySearchCache = new Map()
const AGENCY_SEARCH_CACHE_MS = 24 * 60 * 60 * 1000
const VEHICLE_CACHE_MS = 30 * 24 * 60 * 60 * 1000
const VEHICLE_REQUEST_TIMEOUT_MS = 150_000

function queryString(values) {
  const params = new URLSearchParams()
  Object.entries(values).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') params.set(key, String(value))
  })
  return params.toString()
}

function clean(value) {
  return String(value || '').trim()
}

function number(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function normalized(value) {
  return clean(value).toLowerCase().replace(/[^a-z0-9]+/g, '-')
}

function readVehicleCache(key, { allowExpired = false } = {}) {
  try {
    const entry = JSON.parse(localStorage.getItem(key) || 'null')
    if (!entry?.data || (!allowExpired && entry.expiresAt <= Date.now())) return null
    return entry.data
  } catch {
    return null
  }
}

function writeVehicleCache(key, data) {
  try {
    localStorage.setItem(key, JSON.stringify({
      expiresAt: Date.now() + VEHICLE_CACHE_MS,
      data,
    }))
  } catch {
    // Storage can be unavailable in private browsing or full. The live result
    // is still valid, so cache failure must not break the lookup.
  }
}

function vehicleCacheKey(agency, page, limit) {
  return `tag_agency_vehicles:v2:${agency?.tier || 'toptier'}:${normalized(agency?.parentName)}:${normalized(agency?.name)}:${page}:${limit}`
}

function vehicleCountCacheKey(agency) {
  return `tag_agency_vehicle_count:v2:${agency?.tier || 'toptier'}:${normalized(agency?.parentName)}:${normalized(agency?.name)}`
}

function usageCacheKey(agency, scope) {
  return `tag_agency_vehicle_usage:v2:${scope === 'awarding' ? 'awarding' : 'funding'}:${agency?.tier || 'toptier'}:${normalized(agency?.parentName)}:${normalized(agency?.name)}`
}

function vehicleFilters(agency) {
  const selected = {
    type: 'awarding',
    tier: agency?.tier === 'subtier' ? 'subtier' : 'toptier',
    name: clean(agency?.name),
  }
  if (selected.tier === 'subtier' && agency?.parentName) selected.toptier_name = clean(agency.parentName)
  return { agencies: [selected], award_type_codes: IDV_CODES }
}

function mapVehicleRecord(record) {
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

async function postUSAspending(path, body, signal) {
  const controller = new AbortController()
  const forwardAbort = () => controller.abort(signal?.reason || 'Request cancelled')
  signal?.addEventListener('abort', forwardAbort, { once: true })
  const timeout = setTimeout(() => controller.abort('USAspending request timed out'), VEHICLE_REQUEST_TIMEOUT_MS)
  try {
    const response = await fetch(`${USASPENDING_BASE}${path}`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    if (!response.ok) {
      const error = new Error(`USAspending returned ${response.status}`)
      error.status = response.status
      throw error
    }
    return response.json()
  } catch (error) {
    if (signal?.aborted) throw new DOMException('Request cancelled', 'AbortError')
    if (error?.name === 'AbortError') throw new Error('USAspending took too long to return vehicle data')
    throw error
  } finally {
    clearTimeout(timeout)
    signal?.removeEventListener('abort', forwardAbort)
  }
}

async function getAgencyVehiclesDirectly(agency, { page, limit, forceRefresh, signal }) {
  const filters = vehicleFilters(agency)
  const countKey = vehicleCountCacheKey(agency)
  const cachedCount = forceRefresh ? null : readVehicleCache(countKey)
  const countPromise = cachedCount
    ? Promise.resolve(cachedCount)
    : postUSAspending('/search/spending_by_award_count/', {
      filters,
      spending_level: 'awards',
      subawards: false,
    }, signal)
  const vehiclesPromise = postUSAspending('/search/spending_by_award/', {
    filters,
    fields: VEHICLE_FIELDS,
    page,
    limit,
    sort: 'Last Modified Date',
    order: 'desc',
    subawards: false,
  }, signal)

  const [countResult, vehiclesResult] = await Promise.allSettled([countPromise, vehiclesPromise])
  if (signal?.aborted) throw new DOMException('Request cancelled', 'AbortError')
  if (vehiclesResult.status === 'rejected') throw vehiclesResult.reason
  const countResponse = countResult.status === 'fulfilled' ? countResult.value : null
  if (countResult.status === 'fulfilled' && !cachedCount) writeVehicleCache(countKey, countResult.value)

  return {
    agency,
    vehicles: (vehiclesResult.value?.results || []).map(mapVehicleRecord),
    totalVehicles: countResponse ? number(countResponse?.results?.idvs) : null,
    page,
    limit,
    hasNext: Boolean(vehiclesResult.value?.page_metadata?.hasNext),
    fetchedAt: new Date().toISOString(),
    source: 'USAspending.gov',
    cache: 'live',
    transport: 'browser',
  }
}

async function searchUSAspendingDirectly(query, { signal, limit }) {
  const response = await fetch(USASPENDING_AGENCY_SEARCH, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ search_text: query, limit }),
    signal,
  })
  if (!response.ok) throw new Error(`USAspending returned ${response.status}`)
  const payload = await response.json()
  return {
    agencies: mapOfficialAgencyResults(payload?.results),
    query,
    fetchedAt: new Date().toISOString(),
    source: 'USAspending.gov',
    cache: 'direct',
  }
}

export async function searchOfficialAgencies(query, { signal, limit = 12 } = {}) {
  const cacheKey = `${String(query || '').trim().toLowerCase()}:${limit}`
  const cached = agencySearchCache.get(cacheKey)
  if (cached && cached.expiresAt > Date.now()) return { ...cached.value, cache: 'memory' }
  try {
    const result = await searchUSAspendingDirectly(query, { signal, limit })
    agencySearchCache.set(cacheKey, { value: result, expiresAt: Date.now() + AGENCY_SEARCH_CACHE_MS })
    return result
  } catch (directError) {
    if (signal?.aborted || directError?.name === 'AbortError') throw directError
    try {
      const result = await workerJson(`/agency-intelligence/agencies?${queryString({ q: query, limit })}`, { signal })
      agencySearchCache.set(cacheKey, { value: result, expiresAt: Date.now() + AGENCY_SEARCH_CACHE_MS })
      return result
    } catch (workerError) {
      if (signal?.aborted || workerError?.name === 'AbortError') throw workerError
      console.warn('[Agency Intelligence] Direct and Worker agency search failed', {
        direct: directError?.message,
        worker: workerError?.message,
      })
      throw new Error('Agency search is temporarily unavailable. Please try again.')
    }
  }
}

export function getOfficialAgencyMapping(candidate, { signal } = {}) {
  return workerJson(`/agency-intelligence/resolve?${queryString({
    name: candidate?.name,
    parent: candidate?.parentName,
    departmentId: candidate?.departmentId,
    agencyId: candidate?.agencyId,
  })}`, { signal })
}

export function saveOfficialAgencyMapping(candidate, agency) {
  return workerJson('/agency-intelligence/resolve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ candidate, agency }),
  })
}

export async function getAgencyVehicles(agency, { page = 1, limit = 50, forceRefresh = false, signal } = {}) {
  const cacheKey = vehicleCacheKey(agency, page, limit)
  const cached = forceRefresh ? null : readVehicleCache(cacheKey)
  if (cached) return { ...cached, cache: 'cache', transport: 'browser' }
  const stale = readVehicleCache(cacheKey, { allowExpired: true })

  try {
    const result = await getAgencyVehiclesDirectly(agency, { page, limit, forceRefresh, signal })
    writeVehicleCache(cacheKey, result)
    return result
  } catch (directError) {
    if (signal?.aborted || directError?.name === 'AbortError') throw directError
    try {
      const result = await workerJson(`/agency-intelligence/vehicles?${queryString({
        name: agency?.name,
        tier: agency?.tier,
        parent: agency?.parentName,
        code: agency?.toptierCode,
        page,
        limit,
        refresh: forceRefresh ? 1 : '',
      })}`, { signal })
      const normalizedResult = { ...result, transport: 'worker' }
      writeVehicleCache(cacheKey, normalizedResult)
      return normalizedResult
    } catch (workerError) {
      if (signal?.aborted || workerError?.name === 'AbortError') throw workerError
      console.warn('[Agency Intelligence] Direct and Worker vehicle lookup failed', {
        direct: directError?.message,
        worker: workerError?.message,
      })
      if (stale) {
        return {
          ...stale,
          cache: 'stale',
          warning: 'Fresh vehicle data was unavailable. Showing the most recent saved result.',
        }
      }
      throw new Error('USAspending could not return vehicle data. Please try again.')
    }
  }
}

export function getVehicleActivity(awardId, { forceRefresh = false, signal } = {}) {
  return workerJson(`/agency-intelligence/vehicle?${queryString({
    awardId,
    refresh: forceRefresh ? 1 : '',
  })}`, { signal })
}

export async function getAgencyVehicleUsage(agency, {
  scope = 'funding',
  forceRefresh = false,
  signal,
} = {}) {
  const cacheKey = usageCacheKey(agency, scope)
  const cached = forceRefresh ? null : readVehicleCache(cacheKey)
  if (cached) return { status: 'ready', result: cached, cache: 'browser' }
  const response = await workerJson(`/agency-intelligence/usage?${queryString({
    name: agency?.name,
    tier: agency?.tier,
    parent: agency?.parentName,
    code: agency?.toptierCode,
    scope,
    refresh: forceRefresh ? 1 : '',
  })}`, { signal })
  if (response.status === 'ready' && response.result) writeVehicleCache(cacheKey, response.result)
  return response
}

export async function getAgencyVehicleUsageStatus(agency, { scope = 'funding', signal } = {}) {
  const response = await workerJson(`/agency-intelligence/usage/status?${queryString({
    name: agency?.name,
    tier: agency?.tier,
    parent: agency?.parentName,
    code: agency?.toptierCode,
    scope,
  })}`, { signal })
  if (response.status === 'ready' && response.result) writeVehicleCache(usageCacheKey(agency, scope), response.result)
  return response
}
