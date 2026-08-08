import { workerJson } from './workerClient.js'
import {
  aggregateSamVehicleContracts,
  currentFiveYearWindow,
  samAgencyIdentity,
} from '@/lib/samVehicleIntelligence'

const CACHE_MS = 90 * 24 * 60 * 60 * 1000
const RESOLUTION_BATCH_SIZE = 4
const CHECKPOINT_VERSION = 1
const DATABASE_NAME = 'tag-crm-agency-intelligence'
const STORE_NAME = 'sam-vehicle-reports'
const memorySearchCache = new Map()

function clean(value) {
  return String(value ?? '').trim()
}

function queryString(values) {
  const params = new URLSearchParams()
  Object.entries(values).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') params.set(key, String(value))
  })
  return params.toString()
}

function agencyParams(agency) {
  return {
    name: agency?.searchName || agency?.name,
    parent: agency?.parentName,
    tier: agency?.tier === 'department' ? 'department' : 'subtier',
    departmentId: agency?.departmentId,
    agencyId: agency?.agencyId,
  }
}

function reportCacheKey(agency) {
  return `sam-report:v${CHECKPOINT_VERSION}:${samAgencyIdentity(agency)}`
}

function checkpointKey(agency) {
  return `${reportCacheKey(agency)}:checkpoint`
}

function openDatabase() {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null)
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, 2)
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME)
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

async function readDatabase(key) {
  try {
    const database = await openDatabase()
    if (!database) return null
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readonly')
      const request = transaction.objectStore(STORE_NAME).get(key)
      request.onsuccess = () => resolve(request.result || null)
      request.onerror = () => reject(request.error)
      transaction.oncomplete = () => database.close()
      transaction.onabort = () => database.close()
    })
  } catch {
    return null
  }
}

async function writeDatabase(key, value) {
  try {
    const database = await openDatabase()
    if (!database) return
    await new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readwrite')
      transaction.objectStore(STORE_NAME).put(value, key)
      transaction.oncomplete = resolve
      transaction.onerror = () => reject(transaction.error)
      transaction.onabort = () => reject(transaction.error)
    })
    database.close()
  } catch {
    // Local persistence is an optimization. Live SAM.gov results remain valid.
  }
}

async function deleteDatabase(key) {
  try {
    const database = await openDatabase()
    if (!database) return
    await new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readwrite')
      transaction.objectStore(STORE_NAME).delete(key)
      transaction.oncomplete = resolve
      transaction.onerror = () => reject(transaction.error)
      transaction.onabort = () => reject(transaction.error)
    })
    database.close()
  } catch {
    // Cleanup failure must not hide a valid live result.
  }
}

export async function searchOfficialAgencies(query, { signal, limit = 12 } = {}) {
  const key = `${clean(query).toLowerCase()}:${limit}`
  const cached = memorySearchCache.get(key)
  if (cached?.expiresAt > Date.now()) return { ...cached.value, cache: 'memory' }
  const result = await workerJson(`/agency-intelligence/agencies?${queryString({ q: query, limit })}`, { signal })
  memorySearchCache.set(key, { value: result, expiresAt: Date.now() + CACHE_MS })
  return result
}

async function readSharedReport(agency, signal) {
  try {
    const response = await workerJson(`/agency-intelligence/report?${queryString(agencyParams(agency))}`, { signal })
    return response?.status === 'ready' ? response.result : null
  } catch (error) {
    if (signal?.aborted || error?.name === 'AbortError') throw error
    return null
  }
}

function saveSharedReport(agency, result) {
  return workerJson(`/agency-intelligence/report?${queryString(agencyParams(agency))}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ result }),
  })
}

async function loadContractPage(agency, offset, { signal, forceRefresh }) {
  return workerJson(`/agency-intelligence/contracts?${queryString({
    ...agencyParams(agency),
    offset,
    refresh: forceRefresh ? 1 : '',
  })}`, { signal })
}

async function resolveVehicleBatch(identifiers, { signal, forceRefresh }) {
  return workerJson('/agency-intelligence/vehicles/resolve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifiers, refresh: forceRefresh }),
    signal,
  })
}

function resolutionKey(resolution) {
  return `${clean(resolution?.agencyId).toUpperCase()}|${clean(resolution?.piid).toUpperCase()}`
}

async function buildReport(agency, { signal, forceRefresh, onProgress }) {
  const identity = samAgencyIdentity(agency)
  const period = currentFiveYearWindow()
  const saved = forceRefresh ? null : await readDatabase(checkpointKey(agency))
  const canResume = saved?.version === CHECKPOINT_VERSION && saved?.identity === identity && saved?.period?.endDate === period.endDate
  let contracts = canResume ? (saved.contracts || []) : []
  let offset = canResume ? Math.max(0, Number(saved.offset) || 0) : 0
  let totalRecords = canResume ? Math.max(0, Number(saved.totalRecords) || 0) : 0
  let contractsComplete = Boolean(canResume && saved.contractsComplete)
  let resolutions = canResume ? (saved.resolutions || {}) : {}

  while (!contractsComplete) {
    onProgress?.({ phase: 'contracts', loaded: contracts.length, total: totalRecords, offset })
    const page = await loadContractPage(agency, offset, { signal, forceRefresh })
    const rows = Array.isArray(page?.records) ? page.records : []
    contracts = [...contracts, ...rows]
    totalRecords = Math.max(totalRecords, Number(page?.totalRecords) || 0)
    offset += Number(page?.limit) || rows.length
    contractsComplete = !page?.hasNext || rows.length === 0
    await writeDatabase(checkpointKey(agency), {
      version: CHECKPOINT_VERSION,
      identity,
      period,
      contracts,
      offset,
      totalRecords,
      contractsComplete,
      resolutions,
    })
    onProgress?.({ phase: 'contracts', loaded: contracts.length, total: totalRecords, offset })
  }

  const uniqueIdentifiers = new Map()
  contracts.forEach((contract) => {
    const piid = clean(contract?.parentAwardId).toUpperCase()
    if (!piid) return
    const agencyId = clean(contract?.parentAgencyId).toUpperCase()
    const key = `${agencyId}|${piid}`
    if (!uniqueIdentifiers.has(key)) uniqueIdentifiers.set(key, { piid, agencyId })
  })
  const unresolved = [...uniqueIdentifiers.entries()].filter(([key]) => !resolutions[key])
  for (let index = 0; index < unresolved.length; index += RESOLUTION_BATCH_SIZE) {
    const batch = unresolved.slice(index, index + RESOLUTION_BATCH_SIZE)
    onProgress?.({
      phase: 'vehicles',
      resolved: Object.keys(resolutions).length,
      total: uniqueIdentifiers.size,
    })
    const response = await resolveVehicleBatch(batch.map(([, identifier]) => identifier), { signal, forceRefresh })
    for (const resolution of response?.resolutions || []) resolutions[resolutionKey(resolution)] = resolution
    await writeDatabase(checkpointKey(agency), {
      version: CHECKPOINT_VERSION,
      identity,
      period,
      contracts,
      offset,
      totalRecords,
      contractsComplete: true,
      resolutions,
    })
  }

  const aggregate = aggregateSamVehicleContracts(contracts, resolutions)
  const result = {
    agency,
    period,
    ...aggregate,
    totalRecords,
    unresolvedVehicleIdentifiers: Object.values(resolutions).filter((resolution) => resolution?.resolutionError).length,
    fetchedAt: new Date().toISOString(),
    source: 'SAM.gov',
  }
  await writeDatabase(reportCacheKey(agency), { expiresAt: Date.now() + CACHE_MS, data: result })
  await deleteDatabase(checkpointKey(agency))
  onProgress?.({ phase: 'complete', loaded: contracts.length, total: totalRecords, resolved: uniqueIdentifiers.size })
  saveSharedReport(agency, result).catch((error) => {
    console.warn('[Agency Intelligence] Completed SAM.gov report could not be shared', { error: error?.message })
  })
  return result
}

export async function getAgencyVehicleReport(agency, {
  forceRefresh = false,
  signal,
  onProgress,
} = {}) {
  if (forceRefresh) {
    await Promise.all([
      deleteDatabase(reportCacheKey(agency)),
      deleteDatabase(checkpointKey(agency)),
    ])
  } else {
    const local = await readDatabase(reportCacheKey(agency))
    if (local?.data && local.expiresAt > Date.now()) return { status: 'ready', result: local.data, cache: 'browser' }
    const shared = await readSharedReport(agency, signal)
    if (shared) {
      await writeDatabase(reportCacheKey(agency), { expiresAt: Date.now() + CACHE_MS, data: shared })
      return { status: 'ready', result: shared, cache: 'shared' }
    }
  }

  try {
    const result = await buildReport(agency, { signal, forceRefresh, onProgress })
    return { status: 'ready', result, cache: 'live' }
  } catch (error) {
    if (error?.name !== 'AbortError' && typeof document !== 'undefined' && document.hidden) {
      throw new Error('The report paused while this tab was inactive. Try again to continue from the last completed page.')
    }
    throw error
  }
}
