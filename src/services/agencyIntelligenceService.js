import { workerJson } from './workerClient.js'
import { mapOfficialAgencyResults } from '@/lib/agencyIntelligence'
import {
  agencyUsageFilters,
  agencyUsageIdentity,
  aggregateVehicleOrders,
  currentFiveFiscalYears,
  finalizeVehicleUsage,
} from '@/lib/agencyVehicleUsage'

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
const USAGE_REQUEST_TIMEOUT_MS = 60_000
const USAGE_PAGE_SIZE = 100
const RESOLUTION_CHUNK_SIZE = 25
const USAGE_CHECKPOINT_VERSION = 1
const USAGE_DB_NAME = 'tag-crm-agency-intelligence'
const USAGE_STORE_NAME = 'vehicle-usage'
const ORDER_FIELDS = [
  'Award ID',
  'Recipient Name',
  'Recipient UEI',
  'Award Amount',
  'Description',
  'Last Modified Date',
  'Base Obligation Date',
  'NAICS',
  'PSC',
  'generated_internal_id',
]
const VEHICLE_RESOLUTION_FIELDS = [
  'Award ID',
  'Description',
  'Contract Award Type',
  'Potential Award Amount',
  'Last Date to Order',
  'Last Modified Date',
  'generated_internal_id',
]

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
  return `tag_agency_vehicle_usage:v4:${scope === 'awarding' ? 'awarding' : 'funding'}:${agency?.tier || 'toptier'}:${normalized(agency?.parentName)}:${normalized(agency?.name)}`
}

function usageCheckpointKey(agency, scope) {
  return `${usageCacheKey(agency, scope)}:checkpoint`
}

function openUsageDatabase() {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null)
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(USAGE_DB_NAME, 1)
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(USAGE_STORE_NAME)) {
        request.result.createObjectStore(USAGE_STORE_NAME)
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

async function readUsageDatabase(key) {
  try {
    const database = await openUsageDatabase()
    if (!database) return null
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(USAGE_STORE_NAME, 'readonly')
      const request = transaction.objectStore(USAGE_STORE_NAME).get(key)
      request.onsuccess = () => resolve(request.result || null)
      request.onerror = () => reject(request.error)
      transaction.oncomplete = () => database.close()
      transaction.onabort = () => database.close()
    })
  } catch {
    return null
  }
}

async function writeUsageDatabase(key, value) {
  try {
    const database = await openUsageDatabase()
    if (!database) return
    await new Promise((resolve, reject) => {
      const transaction = database.transaction(USAGE_STORE_NAME, 'readwrite')
      transaction.objectStore(USAGE_STORE_NAME).put(value, key)
      transaction.oncomplete = resolve
      transaction.onerror = () => reject(transaction.error)
      transaction.onabort = () => reject(transaction.error)
    })
    database.close()
  } catch {
    // A checkpoint is an optimization. The live lookup can continue when the
    // browser denies storage or has exhausted its local quota.
  }
}

async function deleteUsageDatabase(key) {
  try {
    const database = await openUsageDatabase()
    if (!database) return
    await new Promise((resolve, reject) => {
      const transaction = database.transaction(USAGE_STORE_NAME, 'readwrite')
      transaction.objectStore(USAGE_STORE_NAME).delete(key)
      transaction.oncomplete = resolve
      transaction.onerror = () => reject(transaction.error)
      transaction.onabort = () => reject(transaction.error)
    })
    database.close()
  } catch {
    // Missing cleanup must not hide a valid completed result.
  }
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

async function postUSAspending(path, body, signal, {
  attempts = 1,
  timeoutMs = VEHICLE_REQUEST_TIMEOUT_MS,
} = {}) {
  let lastError
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const controller = new AbortController()
    const forwardAbort = () => controller.abort(signal?.reason || 'Request cancelled')
    signal?.addEventListener('abort', forwardAbort, { once: true })
    const timeout = setTimeout(() => controller.abort('USAspending request timed out'), timeoutMs)
    try {
      const response = await fetch(`${USASPENDING_BASE}${path}`, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      if (response.ok) return response.json()
      const error = new Error(`USAspending returned ${response.status}`)
      error.status = response.status
      lastError = error
      await response.body?.cancel().catch(() => {})
      if (![429, 502, 503, 504].includes(response.status)) break
    } catch (error) {
      if (signal?.aborted) throw new DOMException('Request cancelled', 'AbortError')
      lastError = error?.name === 'AbortError'
        ? new Error('USAspending took too long to return vehicle data')
        : error
    } finally {
      clearTimeout(timeout)
      signal?.removeEventListener('abort', forwardAbort)
    }
    if (attempt + 1 < attempts) {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 700 * (attempt + 1))
        signal?.addEventListener('abort', () => {
          clearTimeout(timer)
          reject(new DOMException('Request cancelled', 'AbortError'))
        }, { once: true })
      })
    }
  }
  throw lastError || new Error('USAspending is temporarily unavailable')
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

async function readSharedUsage(agency, scope, signal) {
  try {
    const response = await workerJson(`/agency-intelligence/usage?${queryString({
      name: agency?.name,
      tier: agency?.tier,
      parent: agency?.parentName,
      code: agency?.toptierCode,
      scope,
    })}`, { signal })
    return response.status === 'ready' ? response.result : null
  } catch (error) {
    if (signal?.aborted || error?.name === 'AbortError') throw error
    console.warn('[Agency Intelligence] Shared vehicle-usage cache unavailable; building in this browser', {
      error: error?.message || 'Unknown error',
    })
    return null
  }
}

function saveSharedUsage(agency, scope, result) {
  return workerJson(`/agency-intelligence/usage?${queryString({
    name: agency?.name,
    tier: agency?.tier,
    parent: agency?.parentName,
    code: agency?.toptierCode,
    scope,
  })}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ result }),
  })
}

async function loadUsagePage(agency, scope, page, signal) {
  return postUSAspending('/search/spending_by_award/', {
    filters: agencyUsageFilters(agency, scope),
    fields: ORDER_FIELDS,
    page,
    limit: USAGE_PAGE_SIZE,
    sort: 'Last Modified Date',
    order: 'desc',
    subawards: false,
  }, signal, { attempts: 3, timeoutMs: USAGE_REQUEST_TIMEOUT_MS })
}

async function resolveParentVehicles(parentAwardIds, existing, onProgress, signal) {
  const resolutions = { ...(existing || {}) }
  const unresolved = [...new Set(parentAwardIds
    .map((value) => clean(value).toUpperCase())
    .filter((value) => value && !resolutions[value]))]
  let resolvedCount = parentAwardIds.length - unresolved.length
  const chunks = []
  for (let offset = 0; offset < unresolved.length; offset += RESOLUTION_CHUNK_SIZE) {
    chunks.push(unresolved.slice(offset, offset + RESOLUTION_CHUNK_SIZE))
  }

  // Two small requests at a time keep the browser path responsive without
  // recreating the high-concurrency upstream pressure that affected Workers.
  for (let offset = 0; offset < chunks.length; offset += 2) {
    const currentChunks = chunks.slice(offset, offset + 2)
    onProgress?.({
      phase: 'resolving',
      resolvedVehicles: resolvedCount,
      totalVehicles: parentAwardIds.length,
    })
    const responses = await Promise.all(currentChunks.map((awardIds) =>
      postUSAspending('/search/spending_by_award/', {
        filters: {
          award_ids: awardIds.map((awardId) => `"${awardId}"`),
          award_type_codes: IDV_CODES,
        },
        fields: VEHICLE_RESOLUTION_FIELDS,
        page: 1,
        limit: 100,
        sort: 'Last Modified Date',
        order: 'desc',
        subawards: false,
      }, signal, { attempts: 3, timeoutMs: USAGE_REQUEST_TIMEOUT_MS })
    ))

    for (const response of responses) {
      for (const record of response?.results || []) {
        const awardId = clean(record?.['Award ID']).toUpperCase()
        if (!awardId || resolutions[awardId]) continue
        resolutions[awardId] = {
          description: clean(record?.Description),
          vehicleType: clean(record?.['Contract Award Type']),
          generatedId: clean(record?.generated_internal_id),
          ceiling: number(record?.['Potential Award Amount']),
          lastDateToOrder: clean(record?.['Last Date to Order']),
        }
      }
    }
    resolvedCount += currentChunks.reduce((sum, awardIds) => sum + awardIds.length, 0)
    onProgress?.({
      phase: 'resolving',
      resolvedVehicles: Math.min(resolvedCount, parentAwardIds.length),
      totalVehicles: parentAwardIds.length,
    })
  }
  return resolutions
}

async function buildAgencyVehicleUsage(agency, scope, { signal, onProgress } = {}) {
  const checkpointKey = usageCheckpointKey(agency, scope)
  const identity = agencyUsageIdentity(agency, scope)
  const period = currentFiveFiscalYears()
  const saved = await readUsageDatabase(checkpointKey)
  const canResume = saved?.version === USAGE_CHECKPOINT_VERSION &&
    saved?.identity === identity && saved?.period?.endDate === period.endDate
  let page = canResume ? Math.max(1, Number(saved.page) || 1) : 1
  let processedOrders = canResume ? Math.max(0, Number(saved.processedOrders) || 0) : 0
  let aggregate = canResume ? (saved.aggregate || {}) : {}
  let resolutions = canResume ? (saved.resolutions || {}) : {}
  let ordersComplete = Boolean(canResume && saved.ordersComplete)

  if (!ordersComplete) {
    let hasNext = true
    while (hasNext) {
      onProgress?.({ phase: 'loading', processedOrders, activePage: page, page: page - 1 })
      const response = await loadUsagePage(agency, scope, page, signal)
      const rows = Array.isArray(response?.results) ? response.results : []
      aggregate = aggregateVehicleOrders(rows, aggregate)
      processedOrders += rows.length
      hasNext = Boolean(response?.page_metadata?.hasNext) && rows.length > 0
      const completedPage = page
      page += 1
      ordersComplete = !hasNext
      await writeUsageDatabase(checkpointKey, {
        version: USAGE_CHECKPOINT_VERSION,
        identity,
        period,
        page,
        processedOrders,
        aggregate,
        resolutions,
        ordersComplete,
      })
      onProgress?.({
        phase: 'loading',
        processedOrders,
        page: completedPage,
        activePage: hasNext ? page : null,
        totalPages: hasNext ? null : completedPage,
      })
    }
  }

  const parentAwardIds = Object.keys(aggregate)
  resolutions = await resolveParentVehicles(parentAwardIds, resolutions, onProgress, signal)
  const usage = finalizeVehicleUsage(aggregate, resolutions)
  const result = {
    agency,
    scope,
    period,
    ...usage,
    processedOrders,
    unlinkedOrders: Math.max(0, processedOrders - usage.totals.orders),
    fetchedAt: new Date().toISOString(),
    source: 'USAspending.gov',
    transport: 'browser',
  }

  writeVehicleCache(usageCacheKey(agency, scope), result)
  await writeUsageDatabase(usageCacheKey(agency, scope), {
    expiresAt: Date.now() + VEHICLE_CACHE_MS,
    data: result,
  })
  await deleteUsageDatabase(checkpointKey)
  onProgress?.({
    phase: 'complete',
    processedOrders,
    totalOrders: processedOrders,
    resolvedVehicles: parentAwardIds.length,
    totalVehicles: parentAwardIds.length,
  })
  saveSharedUsage(agency, scope, result).catch((error) => {
    console.warn('[Agency Intelligence] Completed usage result could not be shared', {
      error: error?.message || 'Unknown error',
    })
  })
  return result
}

export async function getAgencyVehicleUsage(agency, {
  scope = 'funding',
  forceRefresh = false,
  signal,
  onProgress,
} = {}) {
  const cacheKey = usageCacheKey(agency, scope)
  if (forceRefresh) {
    try { localStorage.removeItem(cacheKey) } catch { /* optional cache */ }
    await Promise.all([
      deleteUsageDatabase(cacheKey),
      deleteUsageDatabase(usageCheckpointKey(agency, scope)),
    ])
  } else {
    const local = readVehicleCache(cacheKey)
    if (local) return { status: 'ready', result: local, cache: 'browser' }
    const stored = await readUsageDatabase(cacheKey)
    if (stored?.data && stored.expiresAt > Date.now()) {
      writeVehicleCache(cacheKey, stored.data)
      return { status: 'ready', result: stored.data, cache: 'browser' }
    }
    const shared = await readSharedUsage(agency, scope, signal)
    if (shared) {
      writeVehicleCache(cacheKey, shared)
      await writeUsageDatabase(cacheKey, {
        expiresAt: Date.now() + VEHICLE_CACHE_MS,
        data: shared,
      })
      return { status: 'ready', result: shared, cache: 'shared' }
    }
  }

  try {
    const result = await buildAgencyVehicleUsage(agency, scope, { signal, onProgress })
    return { status: 'ready', result, cache: 'live' }
  } catch (error) {
    if (error?.name !== 'AbortError' && typeof document !== 'undefined' && document.hidden) {
      throw new Error('Vehicle lookup paused while this tab was inactive. Try again to continue from the last completed page.')
    }
    throw error
  }
}
