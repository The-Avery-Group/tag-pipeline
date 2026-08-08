const SAM_AWARDS_BASE = 'https://api.sam.gov/contract-awards/v1/search'
const PAGE_SIZE = 100
const SEARCH_LIMIT = 100
const RESOLUTION_BATCH_LIMIT = 4
const UPSTREAM_TIMEOUT_MS = 25_000
const UPSTREAM_ATTEMPTS = 2
const CACHE_TTL_SECONDS = 90 * 24 * 60 * 60
const REPORT_CACHE_VERSION = 1

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function clean(value) {
  return String(value ?? '').trim()
}

function number(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function normalize(value) {
  return clean(value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function formatSAMDate(value) {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return `${String(date.getUTCMonth() + 1).padStart(2, '0')}/${String(date.getUTCDate()).padStart(2, '0')}/${date.getUTCFullYear()}`
}

function fiveYearWindow() {
  const end = new Date()
  const start = new Date(Date.UTC(end.getUTCFullYear() - 5, end.getUTCMonth(), end.getUTCDate()))
  return {
    startDate: formatSAMDate(start),
    endDate: formatSAMDate(end),
    firstYear: start.getUTCFullYear(),
    lastYear: end.getUTCFullYear(),
  }
}

function abortAfter(timeoutMs = UPSTREAM_TIMEOUT_MS) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort('SAM.gov request timed out'), timeoutMs)
  return { signal: controller.signal, cancel: () => clearTimeout(timer) }
}

async function fetchSAM(env, params, { timeoutMs = UPSTREAM_TIMEOUT_MS, attempts = UPSTREAM_ATTEMPTS } = {}) {
  if (!env?.SAM_API_KEY) throw new Error('SAM_API_KEY is not configured')
  const query = new URLSearchParams({ api_key: env.SAM_API_KEY, ...params })
  let lastError
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const timeout = abortAfter(timeoutMs)
    try {
      const response = await fetch(`${SAM_AWARDS_BASE}?${query}`, {
        headers: { Accept: 'application/json' },
        signal: timeout.signal,
      })
      if (response.status === 204) return { awardSummary: [], totalRecords: 0, limit: params.limit, offset: params.offset }
      if (!response.ok) {
        const body = await response.text()
        const error = new Error(`SAM.gov Contract Awards API returned ${response.status}${body ? `: ${body.slice(0, 180)}` : ''}`)
        error.status = response.status
        throw error
      }
      return await response.json()
    } catch (error) {
      lastError = error?.name === 'AbortError'
        ? Object.assign(new Error('SAM.gov took too long to return contract data'), { status: 504 })
        : error
      const retryable = [429, 500, 502, 503, 504].includes(Number(lastError?.status))
      if (!retryable || attempt >= attempts - 1) throw lastError
      await new Promise((resolve) => setTimeout(resolve, 350 * (attempt + 1)))
    } finally {
      timeout.cancel()
    }
  }
  throw lastError
}

function recordDate(record) {
  const value = record?.awardDetails?.dates?.dateSigned ||
    record?.awardDetails?.transactionData?.approvedDate ||
    record?.awardDetails?.transactionData?.lastModifiedDate
  const date = value ? new Date(value) : null
  return date && !Number.isNaN(date.getTime()) ? date.getTime() : 0
}

function latestValue(records, getter) {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const value = getter(records[index])
    if (value !== null && value !== undefined && value !== '') return value
  }
  return ''
}

function mapAgencyRecords(records = []) {
  const agencies = new Map()
  for (const record of records) {
    const contracting = record?.coreData?.federalOrganization?.contractingInformation || {}
    const department = contracting.contractingDepartment || {}
    const subtier = contracting.contractingSubtier || {}
    if (clean(department.name)) {
      const key = `department:${clean(department.code)}:${normalize(department.name)}`
      agencies.set(key, {
        tier: 'department',
        name: clean(department.name),
        parentName: clean(department.name),
        departmentId: clean(department.code),
        agencyId: clean(department.code),
      })
    }
    if (clean(subtier.name)) {
      const key = `subtier:${clean(department.code)}:${clean(subtier.code)}:${normalize(subtier.name)}`
      agencies.set(key, {
        tier: 'subtier',
        name: clean(subtier.name),
        parentName: clean(department.name),
        departmentId: clean(department.code),
        agencyId: clean(subtier.code),
      })
    }
  }
  return [...agencies.values()]
}

function compactContract(record) {
  const contract = record?.contractId || {}
  const core = record?.coreData || {}
  const details = record?.awardDetails || {}
  const contracting = core?.federalOrganization?.contractingInformation || {}
  const awardee = details?.awardeeData || {}
  return {
    awardId: clean(contract.piid).toUpperCase(),
    contractingAgencyId: clean(contracting?.contractingSubtier?.code || contract?.subtier?.code),
    contractingAgencyName: clean(contracting?.contractingSubtier?.name || contract?.subtier?.name),
    contractingDepartmentId: clean(contracting?.contractingDepartment?.code),
    contractingDepartmentName: clean(contracting?.contractingDepartment?.name),
    parentAwardId: clean(contract.referencedIDVPiid).toUpperCase(),
    parentAgencyId: clean(contract?.referencedIDVSubtier?.code),
    parentAgencyName: clean(contract?.referencedIDVSubtier?.name),
    title: clean(core.title),
    description: clean(details?.productOrServiceInformation?.descriptionOfContractRequirement),
    awardType: clean(core?.awardOrIDVType?.name),
    referencedVehicleType: clean(details?.contractData?.referencedIDVType?.name || core?.contractData?.referencedIDVType?.name),
    setAside: clean(core?.competitionInformation?.typeOfSetAside?.name),
    contractor: clean(awardee?.awardeeHeader?.awardeeName),
    contractorUEI: clean(awardee?.awardeeUEIInformation?.uniqueEntityId),
    dateSigned: clean(details?.dates?.dateSigned),
    lastModifiedDate: clean(details?.transactionData?.lastModifiedDate),
    totalContractValue: number(details?.totalContractDollars?.totalBaseAndAllOptionsValue || details?.dollars?.baseAndAllOptionsValue),
    totalObligations: number(details?.totalContractDollars?.totalActionObligation || details?.dollars?.totalActionObligation),
    naicsCode: clean(details?.productOrServiceInformation?.principalNaics?.[0]?.code || core?.productOrServiceInformation?.principalNaics?.[0]?.code),
    pscCode: clean(details?.productOrServiceInformation?.productOrService?.code || core?.productOrServiceInformation?.productOrService?.code),
  }
}

function compactVehicle(records = [], identifier = {}) {
  const ordered = [...records].sort((left, right) => recordDate(left) - recordDate(right))
  const vehicleType = latestValue(ordered, (record) => record?.coreData?.awardOrIDVType?.name)
  const title = latestValue(ordered, (record) => record?.coreData?.title)
  const description = latestValue(ordered, (record) => record?.awardDetails?.productOrServiceInformation?.descriptionOfContractRequirement)
  const issuingDepartment = latestValue(ordered, (record) => record?.coreData?.federalOrganization?.contractingInformation?.contractingDepartment?.name)
  const issuingAgency = latestValue(ordered, (record) => record?.coreData?.federalOrganization?.contractingInformation?.contractingSubtier?.name)
  const setAside = latestValue(ordered, (record) => record?.coreData?.competitionInformation?.typeOfSetAside?.name)
  const totalContractValue = latestValue(ordered, (record) => record?.awardDetails?.totalContractDollars?.totalBaseAndAllOptionsValue || record?.awardDetails?.dollars?.baseAndAllOptionsValue)
  const lastDateToOrder = latestValue(ordered, (record) => record?.awardDetails?.dates?.lastDateToOrder)
  return {
    piid: clean(identifier.piid).toUpperCase(),
    agencyId: clean(identifier.agencyId),
    title: clean(title),
    description: clean(description),
    vehicleType: clean(vehicleType),
    issuingDepartment: clean(issuingDepartment),
    issuingAgency: clean(issuingAgency),
    setAside: clean(setAside),
    totalContractValue: number(totalContractValue),
    lastDateToOrder: clean(lastDateToOrder),
  }
}

function cacheRequest(key) {
  return new Request(`https://agency-intelligence-cache.invalid/${encodeURIComponent(key)}`)
}

async function readEdgeCache(key) {
  try {
    const cache = globalThis.caches?.default
    if (!cache) return null
    const response = await cache.match(cacheRequest(key))
    return response ? response.json() : null
  } catch {
    return null
  }
}

async function writeEdgeCache(key, value, ctx) {
  try {
    const cache = globalThis.caches?.default
    if (!cache) return
    const response = new Response(JSON.stringify(value), {
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': `public, max-age=${CACHE_TTL_SECONDS}`,
      },
    })
    const promise = cache.put(cacheRequest(key), response)
    if (ctx?.waitUntil) ctx.waitUntil(promise)
    else await promise
  } catch {
    // Edge caching is an optimization. A live SAM response remains valid.
  }
}

function reportKey(url) {
  const tier = url.searchParams.get('tier') === 'department' ? 'department' : 'subtier'
  const departmentId = clean(url.searchParams.get('departmentId'))
  const agencyId = clean(url.searchParams.get('agencyId'))
  const name = normalize(url.searchParams.get('name'))
  return `agency_sam_report:v${REPORT_CACHE_VERSION}:${tier}:${departmentId}:${agencyId}:${name}`
}

async function searchAgencies(req, env, ctx) {
  const url = new URL(req.url)
  const query = clean(url.searchParams.get('q'))
  const limit = Math.min(25, Math.max(1, Number(url.searchParams.get('limit')) || 12))
  if (query.length < 2) return json({ agencies: [], query, source: 'SAM.gov' })
  const cacheKey = `sam-agency-search:v1:${normalize(query)}:${limit}`
  const cached = await readEdgeCache(cacheKey)
  if (cached) return json({ ...cached, cache: 'edge' })
  const period = fiveYearWindow()
  const common = {
    awardOrIDV: 'Award',
    modificationNumber: '0',
    dateSigned: `[${period.startDate},${period.endDate}]`,
    includeSections: 'contractId,coreData',
    limit: String(SEARCH_LIMIT),
    offset: '0',
  }
  const results = await Promise.allSettled([
    fetchSAM(env, { ...common, contractingSubtierName: query }),
    fetchSAM(env, { ...common, contractingDepartmentName: query }),
  ])
  const records = results.flatMap((result) => result.status === 'fulfilled' ? (result.value?.awardSummary || []) : [])
  if (!records.length && results.every((result) => result.status === 'rejected')) {
    throw results[0].reason
  }
  const target = normalize(query)
  const agencies = mapAgencyRecords(records)
    .map((agency) => ({
      ...agency,
      score: normalize(agency.name) === target ? 3 : normalize(agency.name).includes(target) ? 2 : normalize(agency.parentName).includes(target) ? 1 : 0,
    }))
    .filter((agency) => agency.score > 0)
    .sort((left, right) => right.score - left.score || left.name.localeCompare(right.name))
    .slice(0, limit)
    .map(({ score, ...agency }) => agency)
  const payload = { agencies, query, source: 'SAM.gov', fetchedAt: new Date().toISOString(), cache: 'live' }
  await writeEdgeCache(cacheKey, payload, ctx)
  return json(payload)
}

async function getContractsPage(req, env, ctx) {
  const url = new URL(req.url)
  const tier = url.searchParams.get('tier') === 'department' ? 'department' : 'subtier'
  const departmentId = clean(url.searchParams.get('departmentId'))
  const agencyId = clean(url.searchParams.get('agencyId'))
  const name = clean(url.searchParams.get('name'))
  const parentName = clean(url.searchParams.get('parent'))
  const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0)
  const refresh = url.searchParams.get('refresh') === '1'
  if (tier === 'department' && !departmentId && !parentName) return json({ error: 'A SAM department identifier or name is required' }, 400)
  if (tier === 'subtier' && !agencyId && !name) return json({ error: 'A SAM agency identifier or name is required' }, 400)
  const period = fiveYearWindow()
  const params = {
    awardOrIDV: 'Award',
    modificationNumber: '0',
    dateSigned: `[${period.startDate},${period.endDate}]`,
    includeSections: 'contractId,coreData,awardDetails,awardeeData',
    limit: String(PAGE_SIZE),
    offset: String(offset),
  }
  if (tier === 'department') {
    if (departmentId) params.contractingDepartmentCode = departmentId
    else params.contractingDepartmentName = parentName
  } else if (agencyId) params.contractingSubtierCode = agencyId
  else params.contractingSubtierName = name
  const cacheKey = `sam-contract-page:v2:${tier}:${departmentId}:${agencyId}:${normalize(name)}:${period.startDate}:${offset}`
  if (!refresh) {
    const cached = await readEdgeCache(cacheKey)
    if (cached) return json({ ...cached, cache: 'edge' })
  }
  const data = await fetchSAM(env, params)
  const totalRecords = Math.max(0, Number(data?.totalRecords) || 0)
  const records = (data?.awardSummary || []).map(compactContract)
  const payload = {
    records,
    totalRecords,
    offset,
    limit: PAGE_SIZE,
    hasNext: offset + records.length < totalRecords && records.length > 0,
    period,
    source: 'SAM.gov',
    fetchedAt: new Date().toISOString(),
    cache: 'live',
  }
  await writeEdgeCache(cacheKey, payload, ctx)
  return json(payload)
}

async function resolveOneVehicle(env, identifier, ctx, refresh) {
  const piid = clean(identifier?.piid).toUpperCase()
  const agencyId = clean(identifier?.agencyId)
  if (!piid) return null
  const cacheKey = `sam-vehicle-resolution:v2:${agencyId}:${piid}`
  if (!refresh) {
    const cached = await readEdgeCache(cacheKey)
    if (cached) return { ...cached, cache: 'edge' }
  }
  const params = {
    awardOrIDV: 'IDV',
    piid,
    limit: '100',
    offset: '0',
    includeSections: 'contractId,coreData,awardDetails',
  }
  if (agencyId) params.piidSubtierCode = agencyId
  const data = await fetchSAM(env, params)
  const records = data?.awardSummary || []
  const resolution = compactVehicle(records, { piid, agencyId })
  await writeEdgeCache(cacheKey, resolution, ctx)
  return resolution
}

async function resolveVehicles(req, env, ctx) {
  const body = await req.json().catch(() => ({}))
  const identifiers = Array.isArray(body?.identifiers) ? body.identifiers : []
  const refresh = Boolean(body?.refresh)
  if (!identifiers.length) return json({ resolutions: [], source: 'SAM.gov' })
  if (identifiers.length > RESOLUTION_BATCH_LIMIT) return json({ error: `Resolve no more than ${RESOLUTION_BATCH_LIMIT} vehicle identifiers per request` }, 400)
  const outcomes = await Promise.all(identifiers.map(async (identifier) => {
    try {
      const resolution = await resolveOneVehicle(env, identifier, ctx, refresh)
      return { resolution, failed: false }
    } catch (error) {
      const fallback = {
        piid: clean(identifier?.piid).toUpperCase(),
        agencyId: clean(identifier?.agencyId),
        resolutionError: true,
      }
      console.warn('[Agency Intelligence] Parent IDV resolution skipped', {
        piid: fallback.piid,
        agencyId: fallback.agencyId,
        status: Number(error?.status) || 0,
        message: clean(error?.message).slice(0, 220),
      })
      return { resolution: fallback, failed: true }
    }
  }))
  const resolutions = outcomes.map((outcome) => outcome.resolution).filter(Boolean)
  const failures = outcomes.filter((outcome) => outcome.failed)
  return json({
    resolutions,
    failed: failures.length,
    source: 'SAM.gov',
    fetchedAt: new Date().toISOString(),
  })
}

async function getReport(req, env) {
  const key = reportKey(new URL(req.url))
  const result = await env.CACHE?.get(key, 'json')
  return result ? json({ status: 'ready', result, cache: 'shared' }) : json({ status: 'missing' })
}

async function saveReport(req, env) {
  if (!env.CACHE) return json({ status: 'unavailable' }, 503)
  const body = await req.json().catch(() => ({}))
  const result = body?.result
  if (!result || !Array.isArray(result.vehicles) || !result.totals || result.source !== 'SAM.gov') {
    return json({ error: 'A completed SAM.gov agency vehicle report is required' }, 400)
  }
  await env.CACHE.put(reportKey(new URL(req.url)), JSON.stringify(result), { expirationTtl: CACHE_TTL_SECONDS })
  return json({ status: 'saved' })
}

export async function handleAgencyIntelligence(req, env, ctx) {
  const path = new URL(req.url).pathname
  if (path === '/agency-intelligence/agencies' && req.method === 'GET') return searchAgencies(req, env, ctx)
  if (path === '/agency-intelligence/contracts' && req.method === 'GET') return getContractsPage(req, env, ctx)
  if (path === '/agency-intelligence/vehicles/resolve' && req.method === 'POST') return resolveVehicles(req, env, ctx)
  if (path === '/agency-intelligence/report' && req.method === 'GET') return getReport(req, env)
  if (path === '/agency-intelligence/report' && req.method === 'POST') return saveReport(req, env)
  return json({ error: 'Not found' }, 404)
}

export {
  compactContract,
  compactVehicle,
  mapAgencyRecords,
}
