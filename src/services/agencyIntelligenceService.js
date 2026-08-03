import { workerJson } from './workerClient.js'
import { mapOfficialAgencyResults } from '@/lib/agencyIntelligence'

const USASPENDING_AGENCY_SEARCH = 'https://api.usaspending.gov/api/v2/autocomplete/awarding_agency/'
const agencySearchCache = new Map()
const AGENCY_SEARCH_CACHE_MS = 24 * 60 * 60 * 1000

function queryString(values) {
  const params = new URLSearchParams()
  Object.entries(values).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') params.set(key, String(value))
  })
  return params.toString()
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

export function getAgencyVehicles(agency, { page = 1, limit = 50, forceRefresh = false, signal } = {}) {
  return workerJson(`/agency-intelligence/vehicles?${queryString({
    name: agency?.name,
    tier: agency?.tier,
    parent: agency?.parentName,
    code: agency?.toptierCode,
    page,
    limit,
    refresh: forceRefresh ? 1 : '',
  })}`, { signal })
}

export function getVehicleActivity(awardId, { forceRefresh = false, signal } = {}) {
  return workerJson(`/agency-intelligence/vehicle?${queryString({
    awardId,
    refresh: forceRefresh ? 1 : '',
  })}`, { signal })
}
