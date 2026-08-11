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
const DRIVE_ID = 'b!DvVPmhUD7k2Va33gQGDdB3rFM6P2zkVNvlMvEl7p-levrO3tXf_USZvsR_Sr0bTe'
const PAGE_SIZE = 50
const MAX_PAGES_PER_AGENCY = 80
const CACHE_TTL_SECONDS = 100 * 24 * 60 * 60
const STATUS_KEY = 'expiring_contracts:status:v1'
const AGENCY_REGISTRY_KEY = 'expiring_contracts:agency_registry:v1'
const DATA_PREFIX = 'expiring_contracts:data:v1:'

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
  const custom = agencies.filter((agency) => agency.custom || !DEFAULT_EXPIRING_AGENCIES.some((item) => item.id === agency.id))
  await env.CACHE.put(AGENCY_REGISTRY_KEY, JSON.stringify(custom), { expirationTtl: CACHE_TTL_SECONDS })
}

function normalizeAgency(value, index = 0) {
  if (typeof value === 'string') {
    const searchName = clean(value)
    return { id: `custom-${index}-${searchName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`, label: searchName, searchName, tier: 'subtier', custom: true }
  }
  const searchName = clean(value?.searchName || value?.label)
  const tier = value?.tier === 'department' ? 'department' : 'subtier'
  return {
    id: clean(value?.id) || `custom-${index}-${searchName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
    label: clean(value?.label) || searchName,
    searchName,
    tier,
    custom: Boolean(value?.custom),
  }
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
  const params = new URLSearchParams({
    api_key: env.SAM_API_KEY,
    limit: String(PAGE_SIZE),
    offset: String(offset),
    awardOrIDV: 'Award',
    closedStatus: 'No',
    ultimateCompletionDate: `[${formatSamDate(from)},${formatSamDate(to)}]`,
    naicsCode: naicsCodes.join('~'),
    [agency.tier === 'department' ? 'contractingDepartmentName' : 'contractingSubtierName']: agency.searchName,
  })
  const response = await fetch(`${AWARDS_BASE}?${params}`)
  if (response.status === 204) return { records: [], total: 0, nextOffset: offset, hasMore: false }
  if (!response.ok) {
    const body = await response.text()
    throw new Error(`SAM Contract Awards API returned ${response.status}: ${body.slice(0, 180)}`)
  }
  const payload = await response.json()
  const records = (payload.awardSummary || []).map(compactAwardRecord)
  const total = Number(payload.totalRecords || records.length)
  const nextOffset = offset + records.length
  return { records, total, nextOffset, hasMore: records.length === PAGE_SIZE && nextOffset < total }
}

export async function saveAgencyResults(env, agency, records, fetchedAt = new Date().toISOString()) {
  const families = groupByAwardFamily(dedupeRecords(records))
    .map((family) => summarizeAwardFamily(family))
    .filter((result) => result.eligibility.eligible)
    .sort((left, right) => clean(left.ultimateCompletionDate).localeCompare(clean(right.ultimateCompletionDate)))
  const official = families[0]
    ? { departmentCode: families[0].departmentCode, agencyCode: families[0].agencyCode, agencyName: families[0].agency, departmentName: families[0].department }
    : null
  const value = { agency, official, fetchedAt, contracts: families }
  if (env.CACHE) await env.CACHE.put(resultCacheKey(agency), JSON.stringify(value), { expirationTtl: CACHE_TTL_SECONDS })
  return value
}

export async function runExpiringContractsRefresh(env, event, step) {
  const agencies = (event?.payload?.agencies?.length ? event.payload.agencies : DEFAULT_EXPIRING_AGENCIES)
    .map(normalizeAgency)
    .filter((agency) => agency.searchName)
  const runId = event?.payload?.runId || event?.instanceId || crypto.randomUUID()
  const startedAt = new Date().toISOString()
  try {
    const naicsCodes = await step.do('Read configured NAICS codes', () => readExpiringNAICS(env))
    if (!naicsCodes.length) throw new Error('SAMNAICSTable does not contain any NAICS codes')
    await step.do('Mark expiring contract refresh active', () => setStatus(env, {
      status: 'running', runId, startedAt, agencyIndex: 0, agencyTotal: agencies.length,
      currentAgency: agencies[0]?.label || null, currentPage: 0, currentPages: null, contracts: 0,
    }))

    let totalContracts = 0
    for (let agencyIndex = 0; agencyIndex < agencies.length; agencyIndex += 1) {
      const agency = agencies[agencyIndex]
      let records = []
      let offset = 0
      let pageNumber = 0
      for (; pageNumber < MAX_PAGES_PER_AGENCY; pageNumber += 1) {
        const page = await step.do(
          `Fetch ${agency.id} awards page ${pageNumber + 1}`,
          { retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' }, timeout: '5 minutes' },
          () => fetchExpiringAwardsPage(env, { agency, naicsCodes, offset }),
        )
        records = records.concat(page.records)
        const estimatedPages = Math.max(1, Math.ceil(page.total / PAGE_SIZE))
        await step.do(`Record ${agency.id} progress page ${pageNumber + 1}`, () => setStatus(env, {
          status: 'running', runId, startedAt, agencyIndex, agencyTotal: agencies.length,
          currentAgency: agency.label, currentPage: pageNumber + 1, currentPages: estimatedPages,
          contracts: totalContracts,
        }))
        offset = page.nextOffset
        if (!page.hasMore) break
      }
      const saved = await step.do(`Save ${agency.id} expiring contracts`, () => saveAgencyResults(env, agency, records))
      totalContracts += saved.contracts.length
    }

    const completedAt = new Date().toISOString()
    const complete = { status: 'success', runId, startedAt, completedAt, refreshedAt: completedAt, agencyTotal: agencies.length, contracts: totalContracts }
    await step.do('Complete expiring contract refresh', () => setStatus(env, complete))
    return complete
  } catch (error) {
    const failed = { status: 'error', runId, startedAt, completedAt: new Date().toISOString(), error: error.message }
    await setStatus(env, failed)
    throw error
  }
}

export async function startExpiringContractsRefresh(env, { agencies = DEFAULT_EXPIRING_AGENCIES, scheduledTime = Date.now(), source = 'manual' } = {}) {
  if (!env.EXPIRING_CONTRACTS_WORKFLOW) throw new Error('Expiring contract Workflow binding is unavailable')
  const normalized = agencies.map(normalizeAgency).filter((agency) => agency.searchName)
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
  const created = await env.EXPIRING_CONTRACTS_WORKFLOW.createBatch([{
    id: runId,
    params: { runId, agencies: normalized },
    retention: { successRetention: '3 days', errorRetention: '7 days' },
  }])
  return { started: Boolean(created[0]), runId }
}

function inSelectedRange(contract, range, now = new Date()) {
  const [minimum, maximum] = clean(range || '6-12').split('-').map(Number)
  const date = dateValue(contract.ultimateCompletionDate)
  return date && date >= addMonths(now, minimum || 6) && date <= addMonths(now, maximum || 12)
}

async function loadResults(env, agencies, range) {
  const selected = agencies.length ? agencies : DEFAULT_EXPIRING_AGENCIES
  const cached = await Promise.all(selected.map((agency) => env.CACHE?.get(resultCacheKey(normalizeAgency(agency)), 'json')))
  const available = cached.filter(Boolean)
  const contractsByFamily = new Map()
  available.flatMap((entry) => entry.contracts).forEach((contract) => {
    if (inSelectedRange(contract, range)) contractsByFamily.set(contract.familyKey, contract)
  })
  return {
    agencies: available.map(({ agency, official, fetchedAt, contracts }) => ({ agency, official, fetchedAt, count: contracts.length })),
    contracts: [...contractsByFamily.values()],
    refreshedAt: available.map((entry) => entry.fetchedAt).sort().at(0) || null,
  }
}

function noticeDate(notice) {
  return notice?.postedDate || notice?.award?.date || ''
}

function noticeLink(notice) {
  const value = clean(notice?.uiLink)
  return value && value !== 'null' ? value : null
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
  const unique = new Map()
  responses.forEach((notice) => unique.set(clean(notice.noticeId) || `${notice.title}|${noticeDate(notice)}`, notice))
  return [...unique.values()].sort((left, right) => noticeDate(right).localeCompare(noticeDate(left)))
}

function noticeContacts(notices, agencyName) {
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
        noticeType: clean(notice.type || notice.baseType),
        noticeDate: noticeDate(notice),
        sourceLink: noticeLink(notice),
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
  const notices = await relatedNotices(env, result.solicitationNumber, originalSignedDate)
  const contacts = noticeContacts(notices, result.agency).slice(0, 3)
  return {
    ...result,
    publicPocs: contacts,
    modifications: result.modifications.map((modification) => ({
      ...modification,
      modifierResolution: resolveLastModifiedBy(modification.lastModifiedBy, result.agency, noticeContacts(notices, result.agency)),
    })),
  }
}

export async function handleExpiringContracts(req, env) {
  const url = new URL(req.url)
  try {
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
        : DEFAULT_EXPIRING_AGENCIES
      return json(await loadResults(env, agencies, url.searchParams.get('range') || '6-12'))
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
