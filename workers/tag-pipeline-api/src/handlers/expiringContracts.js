import {
  buildSamGovLink,
  dedupeRecords,
  fetchAwards,
  groupByAwardFamily,
  normalizeIdentifier,
  normalizedIdentifier,
  recordDate,
} from './awards.js'
import { getAppOnlyGraphToken, readWorkbookTable } from '../lib/graph.js'

const AWARDS_BASE = 'https://api.sam.gov/contract-awards/v1/search'
const OPPORTUNITIES_BASE = 'https://api.sam.gov/opportunities/v2/search'
const FEDERAL_HIERARCHY_BASE = 'https://api.sam.gov/prod/federalorganizations/v1/orgs'
const DRIVE_ID = 'b!DvVPmhUD7k2Va33gQGDdB3rFM6P2zkVNvlMvEl7p-levrO3tXf_USZvsR_Sr0bTe'
const PAGE_SIZE = 100
const MAX_PAGES_PER_AGENCY = 40
const PAGES_PER_CHECKPOINT = 6
const MAX_WORKFLOW_CHECKPOINTS = 1000
const CACHE_TTL_SECONDS = 100 * 24 * 60 * 60
const STATUS_KEY = 'expiring_contracts:status:v1'
const AGENCY_REGISTRY_KEY = 'expiring_contracts:agency_registry:v1'
const DATA_PREFIX = 'expiring_contracts:data:v1:'
const RUN_RECORDS_PREFIX = 'expiring_contracts:run_records:v1:'
const HIDDEN_PREFIX = 'expiring_contracts:hidden:v1:'
const MODIFIER_CONTACT_PREFIX = 'expiring_contracts:modifier_contacts:v1:'
const EXCLUDED_SET_ASIDE_QUERY = '!HZC&!HZS&!WOSB&!EDWOSB'
const MODIFIER_CONTACT_TTL_SECONDS = 14 * 24 * 60 * 60

export const DEFAULT_EXPIRING_AGENCIES = [
  { id: 'cdc', label: 'CDC', searchName: 'CENTERS FOR DISEASE CONTROL AND PREVENTION', tier: 'subtier' },
  { id: 'army', label: 'Army', searchName: 'DEPT OF THE ARMY', tier: 'subtier' },
  { id: 'va', label: 'VA', searchName: 'VETERANS AFFAIRS, DEPARTMENT OF', tier: 'department' },
  { id: 'dcsa', label: 'DCSA', searchName: 'DEFENSE COUNTERINTELLIGENCE AND SECURITY AGENCY', tier: 'subtier' },
  { id: 'nasa', label: 'NASA', searchName: 'NATIONAL AERONAUTICS AND SPACE ADMINISTRATION', tier: 'department' },
  { id: 'dha', label: 'DHA', searchName: 'DEFENSE HEALTH AGENCY', tier: 'subtier' },
  { id: 'nih', label: 'NIH', searchName: 'NATIONAL INSTITUTES OF HEALTH', tier: 'subtier' },
  { id: 'asfr', label: 'ASFR', searchName: 'OFFICE OF THE ASSISTANT SECRETARY FOR FINANCIAL RESOURCES', tier: 'subtier' },
]

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function clean(value) {
  return String(value || '').trim()
}

function dateValue(value) {
  const parsed = value ? new Date(value) : null
  return parsed && !Number.isNaN(parsed.getTime()) ? parsed : null
}

function formatSamDate(date) {
  return `${String(date.getUTCMonth() + 1).padStart(2, '0')}/${String(date.getUTCDate()).padStart(2, '0')}/${date.getUTCFullYear()}`
}

function addMonths(date, count) {
  const result = new Date(date)
  result.setUTCMonth(result.getUTCMonth() + count)
  return result
}

function addDays(date, count) {
  const result = new Date(date)
  result.setUTCDate(result.getUTCDate() + count)
  return result
}

function familyKeyFromRecord(record) {
  const contract = record?.contractId || {}
  return [
    contract.subtier?.code || '',
    contract.piid || '',
    contract.referencedIDVSubtier?.code || '',
    contract.referencedIDVPiid || '',
  ].join('|')
}

function latest(records, getter) {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const value = getter(records[index])
    if (value !== null && value !== undefined && value !== '') return value
  }
  return null
}

function latestReason(record) {
  return {
    code: clean(record?.contractId?.reasonForModification?.code).toUpperCase(),
    name: clean(record?.contractId?.reasonForModification?.name),
  }
}

function transactionSnapshot(record) {
  const reason = latestReason(record)
  return {
    modificationNumber: clean(record?.contractId?.modificationNumber) || null,
    transactionNumber: clean(record?.contractId?.transactionNumber) || null,
    dateSigned: record?.awardDetails?.dates?.dateSigned || null,
    approvedDate: record?.awardDetails?.transactionData?.approvedDate || null,
    lastModifiedDate: record?.awardDetails?.transactionData?.lastModifiedDate || null,
    lastModifiedBy: clean(record?.awardDetails?.transactionData?.lastModifiedBy) || null,
    reasonCode: reason.code || null,
    reason: reason.name || null,
    actionObligation: record?.awardDetails?.totalContractDollars?.totalActionObligation ??
      record?.awardDetails?.dollars?.totalActionObligation ?? null,
    ultimateCompletionDate: record?.awardDetails?.dates?.ultimateCompletionDate || null,
    currentCompletionDate: record?.awardDetails?.dates?.currentCompletionDate || null,
  }
}

const STOP_REASONS = new Set(['E', 'F', 'X', 'N', 'K'])

export function contractEligibility(records, nowValue = new Date()) {
  const now = new Date(nowValue)
  let lifecycle = null
  let lastOption = null

  for (const record of records) {
    const reason = latestReason(record)
    if (reason.code === 'G') {
      lifecycle = null
      lastOption = recordDate(record)
      continue
    }
    if (STOP_REASONS.has(reason.code)) {
      lifecycle = {
        code: reason.code,
        reason: reason.name || 'Contract lifecycle action',
        date: record?.awardDetails?.dates?.dateSigned || null,
        modificationNumber: record?.contractId?.modificationNumber || null,
      }
    }
  }

  if (lifecycle) return { eligible: false, reason: 'lifecycle', lifecycle, lastOptionDate: lastOption?.toISOString() || null }

  const currentCompletion = dateValue(latest(records, (record) => record?.awardDetails?.dates?.currentCompletionDate))
  const ultimateCompletion = dateValue(latest(records, (record) => record?.awardDetails?.dates?.ultimateCompletionDate))
  const latestActivity = recordDate(records[records.length - 1])
  const twelveMonthsAgo = addMonths(now, -12)
  const eighteenMonthsAgo = addMonths(now, -18)

  if (lastOption) {
    if (lastOption >= twelveMonthsAgo) return { eligible: true, reason: 'recent-option', lifecycle: null, lastOptionDate: lastOption.toISOString() }
    if (currentCompletion && currentCompletion >= now) return { eligible: true, reason: 'active-option-period', lifecycle: null, lastOptionDate: lastOption.toISOString() }
    return { eligible: false, reason: 'inactive-option-history', lifecycle: null, lastOptionDate: lastOption.toISOString() }
  }

  if (currentCompletion && currentCompletion >= now) return { eligible: true, reason: 'current-period', lifecycle: null, lastOptionDate: null }
  if (ultimateCompletion && ultimateCompletion >= now && latestActivity >= eighteenMonthsAgo) {
    return { eligible: true, reason: 'recent-award-activity', lifecycle: null, lastOptionDate: null }
  }
  return { eligible: false, reason: 'inactive', lifecycle: null, lastOptionDate: null }
}

export function isExcludedExpiringSetAside(value) {
  const normalized = clean(value)
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim()
  return /\bHUB\s*ZONE\b/.test(normalized) ||
    /\bWOM(?:AN|EN)\s+OWNED\b/.test(normalized) ||
    /\b(?:ED)?WOSB\b/.test(normalized)
}

function recordSetAside(record) {
  return record?.coreData?.competitionInformation?.typeOfSetAside?.name
}

export function summarizeAwardFamily(records, now = new Date()) {
  const sorted = [...records].sort((left, right) => recordDate(left) - recordDate(right))
  const eligibility = contractEligibility(sorted, now)
  const latestRecord = sorted[sorted.length - 1]
  const contracting = latest(sorted, (record) => record?.coreData?.federalOrganization?.contractingInformation) || {}
  const totalValue = latest(sorted, (record) =>
    record?.awardDetails?.totalContractDollars?.totalBaseAndAllOptionsValue ??
    record?.awardDetails?.dollars?.baseAndAllOptionsValue
  )
  return {
    familyKey: familyKeyFromRecord(latestRecord),
    piid: latest(sorted, (record) => record?.contractId?.piid),
    title: latest(sorted, (record) => record?.coreData?.title) ||
      latest(sorted, (record) => record?.awardDetails?.productOrServiceInformation?.descriptionOfContractRequirement),
    description: latest(sorted, (record) => record?.awardDetails?.productOrServiceInformation?.descriptionOfContractRequirement),
    department: contracting?.contractingDepartment?.name || null,
    departmentCode: contracting?.contractingDepartment?.code || null,
    agency: contracting?.contractingSubtier?.name || latest(sorted, (record) => record?.contractId?.subtier?.name),
    agencyCode: contracting?.contractingSubtier?.code || latest(sorted, (record) => record?.contractId?.subtier?.code),
    office: contracting?.contractingOffice?.name || null,
    officeCode: contracting?.contractingOffice?.code || null,
    incumbentName: latest(sorted, (record) => record?.awardDetails?.awardeeData?.awardeeHeader?.awardeeName),
    incumbentUEI: latest(sorted, (record) => record?.awardDetails?.awardeeData?.awardeeUEIInformation?.uniqueEntityId),
    naicsCode: latest(sorted, (record) => record?.coreData?.productOrServiceInformation?.principalNaics?.[0]?.code),
    ultimateCompletionDate: latest(sorted, (record) => record?.awardDetails?.dates?.ultimateCompletionDate),
    currentCompletionDate: latest(sorted, (record) => record?.awardDetails?.dates?.currentCompletionDate),
    periodOfPerformanceStartDate: latest(sorted, (record) => record?.awardDetails?.dates?.periodOfPerformanceStartDate),
    totalContractValue: totalValue ?? null,
    awardType: latest(sorted, (record) => record?.coreData?.awardOrIDVType?.name),
    solicitationNumber: latest(sorted, (record) => record?.coreData?.solicitationId),
    referencedIdvPiid: latest(sorted, (record) => record?.contractId?.referencedIDVPiid),
    fiscalYear: latest(sorted, (record) => record?.awardDetails?.dates?.fiscalYear),
    setAside: latest(sorted, (record) => record?.coreData?.competitionInformation?.typeOfSetAside?.name),
    samLink: buildSamGovLink(latestRecord),
    modificationCount: sorted.length,
    modifications: sorted.slice(-3).reverse().map(transactionSnapshot),
    eligibility,
  }
}

function resultCacheKey(agency) {
  return `${DATA_PREFIX}${clean(agency.id).toLowerCase()}`
}

async function getStatus(env) {
  return env.CACHE ? env.CACHE.get(STATUS_KEY, 'json') : null
}

async function setStatus(env, status) {
  if (env.CACHE) await env.CACHE.put(STATUS_KEY, JSON.stringify(status), { expirationTtl: CACHE_TTL_SECONDS })
}

async function agencyRegistry(env) {
  const custom = env.CACHE ? await env.CACHE.get(AGENCY_REGISTRY_KEY, 'json') : []
  const byId = new Map(DEFAULT_EXPIRING_AGENCIES.map((agency) => [agency.id, agency]))
  ;(Array.isArray(custom) ? custom : []).forEach((agency, index) => {
    const normalized = normalizeAgency(agency, index)
    if (normalized.searchName) byId.set(normalized.id, normalized)
  })
  return [...byId.values()]
}

async function saveAgencyRegistry(env, agencies) {
  if (!env.CACHE) return
  const persisted = agencies.filter((agency) => {
    const defaultAgency = DEFAULT_EXPIRING_AGENCIES.find((item) => item.id === agency.id)
    return agency.custom || !defaultAgency || agency.organizationId || agency.agencyCode ||
      agency.searchName !== defaultAgency.searchName || agency.tier !== defaultAgency.tier
  })
  await env.CACHE.put(AGENCY_REGISTRY_KEY, JSON.stringify(persisted))
}

export function normalizeExpiringAgency(value, index = 0) {
  if (typeof value === 'string') {
    const searchName = clean(value)
    return {
      id: `custom-${index}-${searchName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
      label: searchName,
      searchName,
      tier: 'subtier',
      custom: true,
      scheduled: true,
    }
  }
  const searchName = clean(value?.searchName || value?.officialName || value?.label)
  const tier = value?.tier === 'department' ? 'department' : 'subtier'
  return {
    id: clean(value?.id) || `custom-${index}-${searchName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
    label: clean(value?.label) || searchName,
    searchName,
    tier,
    organizationId: clean(value?.organizationId || value?.fhorgid),
    agencyCode: clean(value?.agencyCode || value?.agencycode),
    parentName: clean(value?.parentName || value?.fhagencyorgname),
    scheduled: value?.scheduled !== false,
    custom: Boolean(value?.custom),
  }
}

const normalizeAgency = normalizeExpiringAgency

function agencySearchText(agency) {
  const initials = clean(agency.searchName).split(/[^A-Za-z0-9]+/).filter(Boolean).map((part) => part[0]).join('')
  return [agency.label, agency.searchName, agency.parentName, agency.agencyCode, initials].join(' ').toLowerCase()
}

function federalOrganizationToAgency(value, index = 0) {
  const searchName = clean(value?.fhorgname)
  const organizationId = clean(value?.fhorgid)
  const agencyCode = clean(value?.agencycode)
  const rawType = clean(value?.fhorgtype).toLowerCase()
  const tier = rawType.includes('department') || rawType.includes('ind.') ? 'department' : 'subtier'
  return normalizeAgency({
    id: organizationId ? `fh-${organizationId}` : `fh-${tier}-${agencyCode || index}-${searchName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
    label: searchName,
    searchName,
    tier,
    organizationId,
    agencyCode,
    parentName: clean(value?.fhagencyorgname),
    scheduled: true,
    custom: true,
  }, index)
}

async function fetchFederalOrganizations(env, query) {
  if (!env.SAM_API_KEY) return []
  const params = new URLSearchParams({
    api_key: env.SAM_API_KEY,
    fhorgname: clean(query),
    status: 'active',
    limit: '25',
  })
  const response = await fetch(`${FEDERAL_HIERARCHY_BASE}?${params}`)
  if (response.status === 204 || response.status === 404) return []
  if (!response.ok) throw new Error(`SAM Federal Hierarchy API returned ${response.status}`)
  const payload = await response.json()
  return (Array.isArray(payload.orglist) ? payload.orglist : [])
    .map(federalOrganizationToAgency)
    .filter((agency) => agency.searchName && ['department', 'subtier'].includes(agency.tier))
}

function sameAgencyName(left, right) {
  return clean(left).toUpperCase().replace(/[^A-Z0-9]/g, '') === clean(right).toUpperCase().replace(/[^A-Z0-9]/g, '')
}

function mergeOfficialAgency(agency, official) {
  if (!official) return normalizeAgency(agency)
  const current = normalizeAgency(agency)
  return normalizeAgency({
    ...current,
    searchName: official.searchName || current.searchName,
    organizationId: official.organizationId || current.organizationId,
    agencyCode: official.agencyCode || current.agencyCode,
    parentName: official.parentName || current.parentName,
    tier: official.tier || current.tier,
    custom: current.custom,
  })
}

async function hydrateAgencyCodes(env, agencies) {
  const hydrated = []
  for (const value of agencies) {
    const agency = normalizeAgency(value)
    if (agency.agencyCode) {
      hydrated.push(agency)
      continue
    }

    let official = null
    const cached = env.CACHE ? await env.CACHE.get(resultCacheKey(agency), 'json') : null
    if (cached?.official) {
      const code = agency.tier === 'department'
        ? cached.official.departmentCode
        : cached.official.agencyCode
      const name = agency.tier === 'department'
        ? cached.official.departmentName
        : cached.official.agencyName
      if (code) {
        official = normalizeAgency({
          ...agency,
          searchName: name || agency.searchName,
          agencyCode: code,
          parentName: cached.official.departmentName || agency.parentName,
        })
      }
    }

    if (!official?.agencyCode) {
      try {
        const matches = await fetchFederalOrganizations(env, agency.searchName)
        official = matches.find((match) => match.tier === agency.tier && sameAgencyName(match.searchName, agency.searchName)) ||
          matches.find((match) => match.tier === agency.tier) || null
      } catch (error) {
        console.warn(JSON.stringify({
          event: 'expiring_contract_agency_code_resolution_failed',
          agencyId: agency.id,
          agency: agency.label,
          message: error.message,
        }))
      }
    }
    hydrated.push(mergeOfficialAgency(agency, official))
  }
  await saveAgencyRegistry(env, hydrated)
  return hydrated
}

export async function resolveExpiringAgencies(env, query) {
  const search = clean(query)
  if (search.length < 2) return []
  const existing = await agencyRegistry(env)
  const localMatches = existing
    .filter((agency) => agencySearchText(agency).includes(search.toLowerCase()))
    .map((agency) => ({ ...agency, saved: true, savedId: agency.id }))
  if (!env.SAM_API_KEY) return localMatches.slice(0, 20)

  const officialMatches = (await fetchFederalOrganizations(env, search))
    .map((agency) => {
      const saved = existing.find((item) =>
        item.organizationId === agency.organizationId ||
        (item.tier === agency.tier && item.searchName === agency.searchName)
      )
      return saved ? { ...agency, saved: true, savedId: saved.id } : agency
    })
  const byIdentity = new Map()
  ;[...officialMatches, ...localMatches].forEach((agency) => {
    const key = agency.organizationId || `${agency.tier}:${agency.searchName}`
    const nameKey = `${agency.tier}:${agency.searchName}`
    if (!byIdentity.has(key) && !byIdentity.has(nameKey)) {
      byIdentity.set(key, agency)
      byIdentity.set(nameKey, agency)
    }
  })
  return [...new Set(byIdentity.values())].slice(0, 20)
}

export async function saveExpiringAgency(env, value) {
  const agency = normalizeAgency({ ...value, custom: true, scheduled: value?.scheduled !== false })
  if (!agency.searchName || !agency.agencyCode || !agency.organizationId) {
    throw new Error('Select an official SAM agency match before adding it')
  }
  const registry = await agencyRegistry(env)
  const byId = new Map(registry.map((item) => [item.id, item]))
  byId.set(agency.id, agency)
  await saveAgencyRegistry(env, [...byId.values()])
  return agencyRegistry(env)
}

export async function removeExpiringAgency(env, id) {
  const agencyId = clean(id)
  if (!agencyId) throw new Error('Agency ID is required')
  if (DEFAULT_EXPIRING_AGENCIES.some((agency) => agency.id === agencyId)) {
    throw new Error('Default target agencies cannot be removed')
  }
  const registry = await agencyRegistry(env)
  await saveAgencyRegistry(env, registry.filter((agency) => agency.id !== agencyId))
  return agencyRegistry(env)
}

export function expiringHiddenKey(familyKey) {
  const value = clean(familyKey)
  if (!value) throw new Error('Contract family key is required')
  return `${HIDDEN_PREFIX}${encodeURIComponent(value)}`
}

async function listHiddenContractKeys(env) {
  if (!env.CACHE || typeof env.CACHE.list !== 'function') return new Set()
  const keys = new Set()
  let cursor
  do {
    const page = await env.CACHE.list({ prefix: HIDDEN_PREFIX, limit: 1000, ...(cursor ? { cursor } : {}) })
    ;(page.keys || []).forEach((item) => keys.add(item.name))
    cursor = page.list_complete ? null : page.cursor
  } while (cursor && keys.size < 10000)
  return keys
}

async function setExpiringContractHidden(env, familyKey, hidden) {
  if (!env.CACHE) throw new Error('Shared contract visibility storage is unavailable')
  const key = expiringHiddenKey(familyKey)
  if (hidden) {
    await env.CACHE.put(key, JSON.stringify({ familyKey: clean(familyKey), hiddenAt: new Date().toISOString() }))
  } else {
    await env.CACHE.delete(key)
  }
  return { familyKey: clean(familyKey), hidden: Boolean(hidden) }
}

export async function readExpiringNAICS(env) {
  const token = await getAppOnlyGraphToken(env)
  const rows = await readWorkbookTable(env, DRIVE_ID, token, 'SAMNAICSTable')
  return [...new Set(rows.map((row) => clean(row['NAICS Code'] || row.NAICS || row.Code)).filter(Boolean))].slice(0, 100)
}

function compactAwardRecord(record) {
  return {
    contractId: {
      subtier: record?.contractId?.subtier || null,
      piid: record?.contractId?.piid || null,
      modificationNumber: record?.contractId?.modificationNumber ?? null,
      transactionNumber: record?.contractId?.transactionNumber ?? null,
      referencedIDVSubtier: record?.contractId?.referencedIDVSubtier || null,
      referencedIDVPiid: record?.contractId?.referencedIDVPiid || null,
      reasonForModification: record?.contractId?.reasonForModification || null,
    },
    coreData: {
      awardOrIDV: record?.coreData?.awardOrIDV || null,
      title: record?.coreData?.title || null,
      solicitationId: record?.coreData?.solicitationId || null,
      awardOrIDVType: record?.coreData?.awardOrIDVType || null,
      federalOrganization: {
        contractingInformation: record?.coreData?.federalOrganization?.contractingInformation || null,
      },
      productOrServiceInformation: {
        principalNaics: record?.coreData?.productOrServiceInformation?.principalNaics || null,
      },
      competitionInformation: {
        typeOfSetAside: record?.coreData?.competitionInformation?.typeOfSetAside || null,
      },
    },
    awardDetails: {
      dates: record?.awardDetails?.dates || null,
      transactionData: record?.awardDetails?.transactionData || null,
      awardeeData: {
        awardeeHeader: record?.awardDetails?.awardeeData?.awardeeHeader || null,
        awardeeUEIInformation: record?.awardDetails?.awardeeData?.awardeeUEIInformation || null,
      },
      totalContractDollars: record?.awardDetails?.totalContractDollars || null,
      dollars: record?.awardDetails?.dollars || null,
      productOrServiceInformation: {
        descriptionOfContractRequirement: record?.awardDetails?.productOrServiceInformation?.descriptionOfContractRequirement || null,
      },
    },
  }
}

export async function fetchExpiringAwardsPage(env, { agency, naicsCodes, offset = 0, now = new Date() }) {
  if (!env.SAM_API_KEY) throw new Error('SAM_API_KEY is not configured')
  const from = addMonths(now, 6)
  const to = addMonths(now, 24)
  const normalizedAgency = normalizeAgency(agency)
  const baseParams = {
    api_key: env.SAM_API_KEY,
    limit: String(PAGE_SIZE),
    offset: String(offset),
    awardOrIDV: 'Award',
    closedStatus: 'No',
    typeOfSetAsideCode: EXCLUDED_SET_ASIDE_QUERY,
    ultimateCompletionDate: `[${formatSamDate(from)},${formatSamDate(to)}]`,
    naicsCode: naicsCodes.join('~'),
  }

  const requestPage = async (filterKey, filterValue) => {
    const params = new URLSearchParams({ ...baseParams, [filterKey]: filterValue })
    const response = await fetch(`${AWARDS_BASE}?${params}`)
    if (response.status === 204) return { records: [], total: 0, nextOffset: offset, hasMore: false }
    if (!response.ok) {
      const body = await response.text()
      throw new Error(`SAM Contract Awards API returned ${response.status}: ${body.slice(0, 180)}`)
    }
    const payload = await response.json()
    const rawRecords = payload.awardSummary || []
    const records = rawRecords
      .map(compactAwardRecord)
      .filter((record) => !isExcludedExpiringSetAside(recordSetAside(record)))
    const total = Number(payload.totalRecords || rawRecords.length)
    const nextOffset = offset + rawRecords.length
    return { records, total, nextOffset, hasMore: rawRecords.length === PAGE_SIZE && nextOffset < total }
  }

  const codeFilter = normalizedAgency.tier === 'department' ? 'contractingDepartmentCode' : 'contractingSubtierCode'
  const nameFilter = normalizedAgency.tier === 'department' ? 'contractingDepartmentName' : 'contractingSubtierName'
  if (normalizedAgency.agencyCode) {
    const byCode = await requestPage(codeFilter, normalizedAgency.agencyCode)
    if (byCode.total || offset > 0) return { ...byCode, filter: 'code' }
    const byName = await requestPage(nameFilter, normalizedAgency.searchName)
    return { ...byName, filter: byName.total ? 'name-fallback' : 'code' }
  }
  return { ...(await requestPage(nameFilter, normalizedAgency.searchName)), filter: 'name' }
}

export async function saveAgencyResults(env, agency, records, fetchedAt = new Date().toISOString()) {
  const families = groupByAwardFamily(dedupeRecords(records))
    .map((family) => summarizeAwardFamily(family))
    .filter((result) => result.eligibility.eligible && !isExcludedExpiringSetAside(result.setAside))
    .sort((left, right) => clean(left.ultimateCompletionDate).localeCompare(clean(right.ultimateCompletionDate)))
  const official = families[0]
    ? { departmentCode: families[0].departmentCode, agencyCode: families[0].agencyCode, agencyName: families[0].agency, departmentName: families[0].department }
    : null
  const value = { agency, official, fetchedAt, contracts: families }
  if (env.CACHE) await env.CACHE.put(resultCacheKey(agency), JSON.stringify(value), { expirationTtl: CACHE_TTL_SECONDS })
  return value
}

function runRecordsKey(runId, agencyId) {
  return `${RUN_RECORDS_PREFIX}${runId}:${agencyId}`
}

function continuationInstanceId(runId, checkpoint) {
  const safeRunId = clean(runId).replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 70)
  return `expiring-${safeRunId}-${checkpoint}`
}

async function readCheckpointRecords(env, key, expectedCount = 0) {
  const records = env.CACHE ? await env.CACHE.get(key, 'json') : null
  const result = Array.isArray(records) ? records : []
  if (expectedCount && result.length < expectedCount) {
    throw new Error(`Expiring contract checkpoint data is not ready (${result.length} of ${expectedCount} records)`)
  }
  return result
}

async function checkpointRecordMetadata(env, key, expectedCount = 0) {
  const records = await readCheckpointRecords(env, key, expectedCount)
  return { key, count: records.length }
}

async function writeCheckpointRecords(env, key, records) {
  if (!env.CACHE) throw new Error('CACHE binding is unavailable for expiring contract checkpoints')
  await env.CACHE.put(key, JSON.stringify(records), { expirationTtl: 24 * 60 * 60 })
}

async function clearCheckpointRecords(env, key) {
  if (env.CACHE) await env.CACHE.delete(key)
}

async function scheduleExpiringCheckpoint(env, step, { runId, agencies, checkpoint, continuation }) {
  if (checkpoint > MAX_WORKFLOW_CHECKPOINTS) {
    throw new Error(`Expiring contract refresh exceeded ${MAX_WORKFLOW_CHECKPOINTS} checkpoints`)
  }
  const instanceId = continuationInstanceId(runId, checkpoint)
  const scheduled = await step.do(`Schedule expiring contract checkpoint ${checkpoint}`, async () => {
    const instances = await env.EXPIRING_CONTRACTS_WORKFLOW.createBatch([{
      id: instanceId,
      params: { runId, agencies, checkpoint, continuation },
      retention: { successRetention: '3 days', errorRetention: '7 days' },
    }])
    return { instanceId: instances[0]?.id || instanceId, started: Boolean(instances[0]) }
  })
  return {
    status: 'continuing',
    runId,
    checkpoint: checkpoint - 1,
    nextCheckpoint: checkpoint,
    nextInstanceId: scheduled.instanceId,
  }
}

async function completeExpiringRefresh(env, step, {
  runId,
  startedAt,
  agencies,
  totalContracts,
  agencyErrors,
}) {
  const completedAt = new Date().toISOString()
  const successfulAgencies = agencies.length - agencyErrors.length
  const finalStatus = successfulAgencies === 0 ? 'error' : agencyErrors.length ? 'partial' : 'success'
  const complete = {
    status: finalStatus,
    runId,
    startedAt,
    completedAt,
    refreshedAt: successfulAgencies ? completedAt : null,
    agencyTotal: agencies.length,
    successfulAgencies,
    contracts: totalContracts,
    agencyErrors,
    error: successfulAgencies === 0
      ? 'The refresh could not complete for any selected agency'
      : agencyErrors.length
        ? `${agencyErrors.length} ${agencyErrors.length === 1 ? 'agency' : 'agencies'} could not be refreshed`
        : null,
  }
  await step.do('Complete expiring contract refresh', () => setStatus(env, complete))
  return complete
}

export async function runExpiringContractsRefresh(env, event, step) {
  const payload = event?.payload || {}
  const agencies = (payload.agencies?.length ? payload.agencies : DEFAULT_EXPIRING_AGENCIES)
    .map(normalizeAgency)
    .filter((agency) => agency.searchName)
  const continuation = payload.continuation || {}
  const checkpoint = Math.max(1, Number(payload.checkpoint) || 1)
  const runId = payload.runId || event?.instanceId || crypto.randomUUID()
  const startedAt = continuation.startedAt || payload.startedAt || new Date().toISOString()
  try {
    if (!env.CACHE) throw new Error('CACHE binding is unavailable for expiring contract checkpoints')
    if (checkpoint > MAX_WORKFLOW_CHECKPOINTS) {
      throw new Error(`Expiring contract refresh exceeded ${MAX_WORKFLOW_CHECKPOINTS} checkpoints`)
    }

    const naicsCodes = continuation.naicsCodes?.length
      ? continuation.naicsCodes
      : await step.do('Read configured NAICS codes', () => readExpiringNAICS(env))
    if (!naicsCodes.length) throw new Error('SAMNAICSTable does not contain any NAICS codes')
    const agencyIndex = Math.max(0, Number(continuation.agencyIndex) || 0)
    const totalContracts = Math.max(0, Number(continuation.totalContracts) || 0)
    const agencyErrors = Array.isArray(continuation.agencyErrors) ? continuation.agencyErrors : []
    if (agencyIndex >= agencies.length) {
      return completeExpiringRefresh(env, step, { runId, startedAt, agencies, totalContracts, agencyErrors })
    }

    const agency = agencies[agencyIndex]
    const offset = Math.max(0, Number(continuation.offset) || 0)
    const pageNumber = Math.max(0, Number(continuation.pageNumber) || 0)
    const expectedRecordCount = Math.max(0, Number(continuation.storedRecordCount) || 0)
    const recordsKey = runRecordsKey(runId, agency.id)
    let priorRecords = []
    if (expectedRecordCount) {
      await step.do(
        `Verify ${agency.id} checkpoint records ${checkpoint}`,
        { retries: { limit: 5, delay: '2 seconds', backoff: 'exponential' } },
        () => checkpointRecordMetadata(env, recordsKey, expectedRecordCount),
      )
      // Checkpoint collections can exceed the 1 MiB Workflow step-output limit.
      // Keep the collection in KV and read it without returning it from step.do().
      priorRecords = await readCheckpointRecords(env, recordsKey, expectedRecordCount)
    }

    await step.do(`Mark expiring checkpoint ${checkpoint} active`, () => setStatus(env, {
      status: 'running', runId, startedAt, agencyIndex, agencyTotal: agencies.length,
      currentAgency: agency.label, currentPage: pageNumber, currentPages: continuation.currentPages || null,
      contracts: totalContracts, agencyErrors, checkpoint,
    }))

    try {
      let currentOffset = offset
      let currentPageNumber = pageNumber
      let currentPages = continuation.currentPages || null
      let hasMore = true
      const batchRecords = []

      for (let pageIndex = 0; pageIndex < PAGES_PER_CHECKPOINT && hasMore && currentPageNumber < MAX_PAGES_PER_AGENCY; pageIndex += 1) {
        const page = await step.do(
          `Fetch ${agency.id} awards page ${currentPageNumber + 1}`,
          { retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' }, timeout: '5 minutes' },
          () => fetchExpiringAwardsPage(env, { agency, naicsCodes, offset: currentOffset }),
        )
        batchRecords.push(...page.records)
        currentOffset = page.nextOffset
        currentPageNumber += 1
        currentPages = Math.min(MAX_PAGES_PER_AGENCY, Math.max(1, Math.ceil(page.total / PAGE_SIZE)))
        hasMore = page.hasMore && currentPageNumber < MAX_PAGES_PER_AGENCY
      }

      const records = dedupeRecords(priorRecords.concat(batchRecords))
      if (hasMore) {
        await step.do(`Store ${agency.id} checkpoint records ${checkpoint}`, () => writeCheckpointRecords(env, recordsKey, records))
        const nextContinuation = {
          startedAt,
          naicsCodes,
          agencyIndex,
          offset: currentOffset,
          pageNumber: currentPageNumber,
          currentPages,
          storedRecordCount: records.length,
          totalContracts,
          agencyErrors,
        }
        await step.do(`Record expiring checkpoint ${checkpoint} progress`, () => setStatus(env, {
          status: 'running', runId, startedAt, agencyIndex, agencyTotal: agencies.length,
          currentAgency: agency.label, currentPage: currentPageNumber, currentPages,
          contracts: totalContracts, agencyErrors, checkpoint,
        }))
        return scheduleExpiringCheckpoint(env, step, {
          runId, agencies, checkpoint: checkpoint + 1, continuation: nextContinuation,
        })
      }

      const saved = await step.do(`Save ${agency.id} expiring contracts`, async () => {
        const value = await saveAgencyResults(env, agency, records)
        return { contractCount: value.contracts.length }
      })
      await step.do(`Clear ${agency.id} checkpoint records`, () => clearCheckpointRecords(env, recordsKey))
      const nextTotalContracts = totalContracts + saved.contractCount
      const nextAgencyIndex = agencyIndex + 1
      if (nextAgencyIndex >= agencies.length) {
        return completeExpiringRefresh(env, step, {
          runId, startedAt, agencies, totalContracts: nextTotalContracts, agencyErrors,
        })
      }
      await step.do(`Complete ${agency.id} refresh stage`, () => setStatus(env, {
        status: 'running', runId, startedAt, agencyIndex: nextAgencyIndex, agencyTotal: agencies.length,
        currentAgency: agencies[nextAgencyIndex].label, currentPage: 0, currentPages: null,
        contracts: nextTotalContracts, agencyErrors, checkpoint,
      }))
      return scheduleExpiringCheckpoint(env, step, {
        runId,
        agencies,
        checkpoint: checkpoint + 1,
        continuation: {
          startedAt, naicsCodes, agencyIndex: nextAgencyIndex, offset: 0, pageNumber: 0,
          currentPages: null, storedRecordCount: 0, totalContracts: nextTotalContracts, agencyErrors,
        },
      })
    } catch (error) {
      const issue = { agencyId: agency.id, agency: agency.label, error: error.message }
      const nextAgencyErrors = [...agencyErrors, issue]
      console.error(JSON.stringify({ event: 'expiring_contract_agency_failed', runId, ...issue }))
      await step.do(`Clear failed ${agency.id} checkpoint records`, () => clearCheckpointRecords(env, recordsKey))
      const nextAgencyIndex = agencyIndex + 1
      if (nextAgencyIndex >= agencies.length) {
        return completeExpiringRefresh(env, step, {
          runId, startedAt, agencies, totalContracts, agencyErrors: nextAgencyErrors,
        })
      }
      await step.do(`Record failed ${agency.id} refresh stage`, () => setStatus(env, {
        status: 'running', runId, startedAt, agencyIndex: nextAgencyIndex, agencyTotal: agencies.length,
        currentAgency: agencies[nextAgencyIndex].label, currentPage: 0, currentPages: null,
        contracts: totalContracts, agencyErrors: nextAgencyErrors, checkpoint,
      }))
      return scheduleExpiringCheckpoint(env, step, {
        runId,
        agencies,
        checkpoint: checkpoint + 1,
        continuation: {
          startedAt, naicsCodes, agencyIndex: nextAgencyIndex, offset: 0, pageNumber: 0,
          currentPages: null, storedRecordCount: 0, totalContracts, agencyErrors: nextAgencyErrors,
        },
      })
    }
  } catch (error) {
    const failed = { status: 'error', runId, startedAt, completedAt: new Date().toISOString(), error: error.message }
    await setStatus(env, failed)
    console.error(JSON.stringify({ event: 'expiring_contract_refresh_failed', runId, error: error.message }))
    return failed
  }
}

export async function startExpiringContractsRefresh(env, { agencies, scheduledTime = Date.now(), source = 'manual' } = {}) {
  if (!env.EXPIRING_CONTRACTS_WORKFLOW) throw new Error('Expiring contract Workflow binding is unavailable')
  const configured = Array.isArray(agencies) && agencies.length
    ? agencies
    : (await agencyRegistry(env)).filter((agency) => agency.scheduled !== false)
  const normalized = (await hydrateAgencyCodes(env, configured))
    .map(normalizeAgency)
    .filter((agency) => agency.searchName)
  const existingRegistry = await agencyRegistry(env)
  const mergedRegistry = new Map(existingRegistry.map((agency) => [agency.id, agency]))
  normalized.forEach((agency) => mergedRegistry.set(agency.id, agency))
  await saveAgencyRegistry(env, [...mergedRegistry.values()])
  const stamp = new Date(scheduledTime).toISOString().replace(/[:.]/g, '-')
  const runId = `expiring-${source}-${stamp}`.slice(0, 95)
  await setStatus(env, {
    status: 'queued', runId, startedAt: new Date().toISOString(), agencyIndex: 0,
    agencyTotal: normalized.length, currentAgency: normalized[0]?.label || null, contracts: 0,
  })
  const startedAt = new Date().toISOString()
  try {
    const created = await env.EXPIRING_CONTRACTS_WORKFLOW.createBatch([{
      id: runId,
      params: {
        runId,
        agencies: normalized,
        checkpoint: 1,
        continuation: {
          startedAt,
          agencyIndex: 0,
          offset: 0,
          pageNumber: 0,
          storedRecordCount: 0,
          totalContracts: 0,
          agencyErrors: [],
        },
      },
      retention: { successRetention: '3 days', errorRetention: '7 days' },
    }])
    return { started: Boolean(created[0]), runId }
  } catch (error) {
    await setStatus(env, {
      status: 'error', runId, startedAt: new Date().toISOString(), completedAt: new Date().toISOString(),
      error: `The refresh could not start: ${error.message}`,
    })
    throw error
  }
}

function inSelectedRange(contract, range, now = new Date()) {
  const [minimum, maximum] = clean(range || '6-12').split('-').map(Number)
  const date = dateValue(contract.ultimateCompletionDate)
  return date && date >= addMonths(now, minimum || 6) && date <= addMonths(now, maximum || 12)
}

async function loadResults(env, agencies, range, includeHidden = false) {
  const selected = agencies.length ? agencies : await agencyRegistry(env)
  const cached = await Promise.all(selected.map((agency) => env.CACHE?.get(resultCacheKey(normalizeAgency(agency)), 'json')))
  const available = cached.filter(Boolean).map((entry) => ({
    ...entry,
    contracts: (entry.contracts || []).filter((contract) => !isExcludedExpiringSetAside(contract.setAside)),
  }))
  const contractsByFamily = new Map()
  available.flatMap((entry) => entry.contracts).forEach((contract) => {
    if (inSelectedRange(contract, range)) contractsByFamily.set(contract.familyKey, contract)
  })
  const hiddenKeys = await listHiddenContractKeys(env)
  const allContracts = [...contractsByFamily.values()].map((contract) => ({
    ...contract,
    hidden: hiddenKeys.has(expiringHiddenKey(contract.familyKey)),
  }))
  const hiddenCount = allContracts.filter((contract) => contract.hidden).length
  return {
    agencies: available.map(({ agency, official, fetchedAt, contracts }) => ({ agency, official, fetchedAt, count: contracts.length })),
    contracts: includeHidden ? allContracts : allContracts.filter((contract) => !contract.hidden),
    hiddenCount,
    refreshedAt: available.map((entry) => entry.fetchedAt).sort().at(0) || null,
  }
}

function noticeDate(notice) {
  return notice?.postedDate || notice?.award?.date || ''
}

function noticeLink(notice) {
  const value = clean(notice?.uiLink)
  if (value && value !== 'null') return value
  const noticeId = clean(notice?.noticeId)
  return noticeId ? `https://sam.gov/opp/${encodeURIComponent(noticeId)}/view` : null
}

function noticeType(notice) {
  return clean(notice?.type || notice?.baseType || notice?.noticeType)
}

function isAwardNotice(notice) {
  const type = noticeType(notice).toLowerCase()
  return type === 'a' || type.includes('award')
}

function dedupeNotices(notices) {
  const unique = new Map()
  notices.forEach((notice) => unique.set(clean(notice.noticeId) || `${notice.title}|${noticeDate(notice)}`, notice))
  return [...unique.values()]
}

async function fetchNotices(env, solicitationNumber, from, to) {
  const params = new URLSearchParams({
    api_key: env.SAM_API_KEY,
    solnum: solicitationNumber,
    postedFrom: formatSamDate(from),
    postedTo: formatSamDate(to),
    limit: '100',
    offset: '0',
  })
  ;['r', 'o', 'k', 'a', 'p', 's'].forEach((type) => params.append('ptype', type))
  const response = await fetch(`${OPPORTUNITIES_BASE}?${params}`)
  if (response.status === 204) return []
  if (!response.ok) return []
  const payload = await response.json()
  return payload.opportunitiesData || payload.data || []
}

async function relatedNotices(env, solicitationNumber, originalSignedDate) {
  if (!solicitationNumber) return []
  const now = new Date()
  const identifiers = [...new Set([clean(solicitationNumber), clean(solicitationNumber).replace(/-/g, '')].filter(Boolean))]
  const windows = [{ from: addDays(now, -364), to: now }]
  const original = dateValue(originalSignedDate)
  if (original) windows.push({ from: addDays(original, -180), to: addDays(original, 180) })
  const responses = []
  for (const identifier of identifiers) {
    for (const window of windows) responses.push(...await fetchNotices(env, identifier, window.from, window.to))
  }
  return dedupeNotices(responses).sort((left, right) => noticeDate(right).localeCompare(noticeDate(left)))
}

export function modifierNoticeWindows(modifications, paddingDays = 30) {
  const windows = (Array.isArray(modifications) ? modifications : [])
    .map((modification) => dateValue(modification?.lastModifiedDate || modification?.dateSigned))
    .filter(Boolean)
    .map((date) => ({ from: addDays(date, -paddingDays), to: addDays(date, paddingDays) }))
    .sort((left, right) => left.from - right.from)
  const merged = []
  windows.forEach((window) => {
    const previous = merged.at(-1)
    if (previous && window.from <= addDays(previous.to, 1) && window.to <= addDays(previous.from, 364)) {
      if (window.to > previous.to) previous.to = window.to
    } else {
      merged.push({ ...window })
    }
  })
  return merged
}

async function requestAgencyNotices(env, { agencyCode, agencyName, from, to, useName = false }) {
  const today = new Date()
  if (from > today) return []
  const safeTo = to > today ? today : to
  const params = new URLSearchParams({
    api_key: env.SAM_API_KEY,
    postedFrom: formatSamDate(from),
    postedTo: formatSamDate(safeTo),
    limit: '1000',
    offset: '0',
    [useName || !agencyCode ? 'organizationName' : 'organizationCode']: useName || !agencyCode ? agencyName : agencyCode,
  })
  ;['a', 'r', 'o', 'k', 'p', 's'].forEach((type) => params.append('ptype', type))
  const response = await fetch(`${OPPORTUNITIES_BASE}?${params}`)
  if (response.status === 204 || response.status === 404) return []
  if (!response.ok) {
    console.warn(JSON.stringify({
      event: 'expiring_contract_modifier_notice_search_failed',
      agencyCode,
      agencyName,
      status: response.status,
    }))
    return []
  }
  const payload = await response.json()
  return payload.opportunitiesData || payload.data || []
}

export async function fetchAgencyModifierNotices(env, { agencyCode, agencyName, modifications }) {
  if (!env.SAM_API_KEY || (!agencyCode && !agencyName)) return []
  const notices = []
  for (const window of modifierNoticeWindows(modifications)) {
    const byCode = await requestAgencyNotices(env, { agencyCode, agencyName, ...window })
    notices.push(...byCode)
    if (!byCode.length && agencyCode && agencyName) {
      notices.push(...await requestAgencyNotices(env, { agencyCode, agencyName, ...window, useName: true }))
    }
  }
  return dedupeNotices(notices).sort((left, right) => {
    const awardDifference = Number(isAwardNotice(right)) - Number(isAwardNotice(left))
    return awardDifference || noticeDate(right).localeCompare(noticeDate(left))
  })
}

export function noticeContacts(notices, agencyName) {
  const contacts = []
  for (const notice of notices) {
    for (const poc of Array.isArray(notice?.pointOfContact) ? notice.pointOfContact : []) {
      contacts.push({
        name: clean(poc.fullName || poc.fullname),
        role: clean(poc.title || poc.type),
        email: clean(poc.email),
        phone: clean(poc.phone),
        agency: agencyName,
        noticeId: clean(notice.noticeId),
        noticeTitle: clean(notice.title),
        noticeType: noticeType(notice),
        noticeDate: noticeDate(notice),
        sourceLink: noticeLink(notice),
        sourceLabel: isAwardNotice(notice) ? 'SAM award notice' : 'SAM opportunity notice',
      })
    }
  }
  const unique = new Map()
  contacts.forEach((contact) => {
    const key = contact.email.toLowerCase() || contact.name.toLowerCase()
    if (key && !unique.has(key)) unique.set(key, contact)
  })
  return [...unique.values()]
}

function dedupeContacts(contacts) {
  const unique = new Map()
  contacts.forEach((contact) => {
    const key = clean(contact.email).toLowerCase() || `${clean(contact.name).toLowerCase()}|${clean(contact.agency).toLowerCase()}`
    if (key && !unique.has(key)) unique.set(key, contact)
  })
  return [...unique.values()]
}

export function matchingModifierContacts(contacts, modifications, agencyName) {
  return dedupeContacts(contacts).filter((contact) => (Array.isArray(modifications) ? modifications : []).some((modification) =>
    resolveLastModifiedBy(modification.lastModifiedBy, agencyName, [contact]).status === 'matched'
  ))
}

function nameCode(name) {
  const parts = clean(name).toUpperCase().replace(/[^A-Z ]/g, ' ').split(/\s+/).filter(Boolean)
  if (parts.length < 2) return ''
  return `${parts[0][0]}${parts[parts.length - 1]}`
}

export function resolveLastModifiedBy(rawValue, agencyName, contacts) {
  const raw = clean(rawValue)
  if (!raw) return { raw, status: 'empty', matches: [] }
  if (/CLOSEOUT|SYSTEM|BATCH|SERVICE/i.test(raw)) return { raw, status: 'system', label: 'System account', matches: [] }
  const agency = clean(agencyName).toUpperCase()
  const rawEmail = raw.toLowerCase()
  let matches = []
  if (agency.includes('CENTERS FOR DISEASE') || agency.includes('NATIONAL INSTITUTES OF HEALTH') || agency.includes('ASSISTANT SECRETARY FOR FINANCIAL')) {
    const code = raw.toUpperCase().startsWith('HHS') ? raw.toUpperCase().slice(3) : ''
    if (code) matches = contacts.filter((contact) => nameCode(contact.name) === code)
  } else if (raw.includes('@')) {
    matches = contacts.filter((contact) => contact.email.toLowerCase() === rawEmail)
  }
  if (matches.length === 1) return { raw, status: 'matched', matches }
  if (matches.length > 1) return { raw, status: 'multiple', matches }
  return { raw, status: 'unresolved', matches: [] }
}

async function loadContractDetail(env, url) {
  const piid = clean(url.searchParams.get('piid'))
  const uei = normalizeIdentifier(url.searchParams.get('uei'))
  if (!piid) throw new Error('PIID is required')
  const records = dedupeRecords((await fetchAwards(env, { piid })).records)
  const families = groupByAwardFamily(records)
  const family = families.find((candidate) => {
    if (!uei) return true
    return normalizeIdentifier(latest(candidate, (record) => record?.awardDetails?.awardeeData?.awardeeUEIInformation?.uniqueEntityId)) === uei
  })
  if (!family) throw new Error('No matching award family was found')
  const result = summarizeAwardFamily(family)
  const originalSignedDate = family[0]?.awardDetails?.dates?.dateSigned
  const solicitationNotices = await relatedNotices(env, result.solicitationNumber, originalSignedDate)
  const solicitationContacts = noticeContacts(solicitationNotices, result.agency)
  let resolutionContacts = solicitationContacts
  const needsAgencyDateFallback = result.modifications.some((modification) => {
    const resolution = resolveLastModifiedBy(modification.lastModifiedBy, result.agency, resolutionContacts)
    return resolution.status === 'unresolved' && (clean(modification.lastModifiedBy).includes('@') || clean(modification.lastModifiedBy).toUpperCase().startsWith('HHS'))
  })
  let fallbackContacts = []
  if (needsAgencyDateFallback) {
    const fallbackKey = `${MODIFIER_CONTACT_PREFIX}${encodeURIComponent(result.familyKey)}`
    let cached = null
    try {
      cached = env.CACHE ? await env.CACHE.get(fallbackKey, 'json') : null
    } catch (error) {
      console.warn(JSON.stringify({ event: 'expiring_contract_modifier_contact_cache_read_failed', message: error.message }))
    }
    if (Array.isArray(cached)) {
      fallbackContacts = cached
    } else {
      const agencyNotices = await fetchAgencyModifierNotices(env, {
        agencyCode: result.agencyCode,
        agencyName: result.agency,
        modifications: result.modifications,
      })
      const candidates = noticeContacts(agencyNotices, result.agency)
      fallbackContacts = matchingModifierContacts(candidates, result.modifications, result.agency)
      if (env.CACHE) {
        try {
          await env.CACHE.put(fallbackKey, JSON.stringify(fallbackContacts), { expirationTtl: MODIFIER_CONTACT_TTL_SECONDS })
        } catch (error) {
          console.warn(JSON.stringify({ event: 'expiring_contract_modifier_contact_cache_write_failed', message: error.message }))
        }
      }
    }
  }
  resolutionContacts = dedupeContacts([...fallbackContacts, ...solicitationContacts])
  const contacts = dedupeContacts([...solicitationContacts, ...fallbackContacts]).slice(0, 3)
  return {
    ...result,
    publicPocs: contacts,
    modifications: result.modifications.map((modification) => ({
      ...modification,
      modifierResolution: resolveLastModifiedBy(modification.lastModifiedBy, result.agency, resolutionContacts),
    })),
  }
}

export async function handleExpiringContracts(req, env) {
  const url = new URL(req.url)
  try {
    if (url.pathname === '/sam/expiring-contracts/agencies/resolve' && req.method === 'GET') {
      return json({ agencies: await resolveExpiringAgencies(env, url.searchParams.get('q')) })
    }
    if (url.pathname === '/sam/expiring-contracts/agencies' && req.method === 'POST') {
      const body = await req.json().catch(() => ({}))
      return json({ agencies: await saveExpiringAgency(env, body.agency) })
    }
    if (url.pathname === '/sam/expiring-contracts/agencies' && req.method === 'DELETE') {
      return json({ agencies: await removeExpiringAgency(env, url.searchParams.get('id')) })
    }
    if (url.pathname === '/sam/expiring-contracts/visibility' && req.method === 'POST') {
      const body = await req.json().catch(() => ({}))
      return json(await setExpiringContractHidden(env, body.familyKey, body.hidden))
    }
    if (url.pathname === '/sam/expiring-contracts/config' && req.method === 'GET') {
      return json({ agencies: await agencyRegistry(env), ranges: ['6-12', '12-18', '18-24'] })
    }
    if (url.pathname === '/sam/expiring-contracts/status' && req.method === 'GET') {
      return json((await getStatus(env)) || { status: 'idle' })
    }
    if (url.pathname === '/sam/expiring-contracts/results' && req.method === 'GET') {
      const requested = clean(url.searchParams.get('agencies')).split(',').filter(Boolean)
      const registry = await agencyRegistry(env)
      const agencies = requested.length
        ? registry.filter((agency) => requested.includes(agency.id))
        : registry
      return json(await loadResults(
        env,
        agencies,
        url.searchParams.get('range') || '6-12',
        url.searchParams.get('includeHidden') === '1',
      ))
    }
    if (url.pathname === '/sam/expiring-contracts/refresh' && req.method === 'POST') {
      const body = await req.json().catch(() => ({}))
      return json(await startExpiringContractsRefresh(env, { agencies: body.agencies, source: 'manual' }), 202)
    }
    if (url.pathname === '/sam/expiring-contracts/detail' && req.method === 'GET') {
      return json(await loadContractDetail(env, url))
    }
    return json({ error: 'Not found' }, 404)
  } catch (error) {
    console.error('[Expiring contracts]', error.message)
    return json({ error: error.message }, 502)
  }
}
