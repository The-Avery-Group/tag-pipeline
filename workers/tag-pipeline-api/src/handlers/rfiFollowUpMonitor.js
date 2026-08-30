import { followUpCandidate } from './sam.js'
import { getAppOnlyGraphToken, readWorkbookTable } from '../lib/graph.js'
import { findEbuyPipelineSource, listEbuyFollowOnCandidates } from '../lib/ebuyRepository.js'
import { putAutomationRun } from '../lib/automationHealth.js'
import { isFollowOnSourceOpportunity } from '../lib/noticeTypes.js'
import {
  acknowledgeOpportunityAlert,
  alertFingerprint,
  alertStorageReady,
  getOpportunityAlert,
  resolveOpportunityAlert,
  upsertOpportunityAlert,
} from '../lib/opportunityAlerts.js'

const WATCH_PREFIX = 'rfi_followup_watch:'
const RUN_KEY = 'rfi_followup_monitor_run'
const STATUS_SNAPSHOT_KEY = 'rfi_followup_status_snapshot_v1'
const BATCH_SIZE = 3
const DAILY_MS = 24 * 60 * 60 * 1000
const TITLE_MATCHER_VERSION = 2
const DRIVE_ID = 'b!DvVPmhUD7k2Va33gQGDdB3rFM6P2zkVNvlMvEl7p-levrO3tXf_USZvsR_Sr0bTe'

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
}

function clean(value) { return String(value || '').trim() }
function normalized(value) { return clean(value).toLowerCase().replace(/\s+/g, ' ') }
function boolean(value, fallback = true) {
  if (value === undefined || value === null || value === '') return fallback
  return ['true', 'yes', 'enabled', '1'].includes(clean(value).toLowerCase())
}
function number(value, fallback, min, max) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : fallback
}

function workbookDate(value) {
  if (typeof value !== 'number') return clean(value)
  const date = new Date((value - 25569) * 86400000)
  return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 10)
}

function hash(value) {
  let out = 2166136261
  for (const char of String(value)) { out ^= char.charCodeAt(0); out = Math.imul(out, 16777619) }
  return (out >>> 0).toString(36)
}

function watchKey(opportunityId) { return `${WATCH_PREFIX}${hash(normalized(opportunityId))}` }
function candidateKey(candidate) { return `${normalized(candidate.source || 'SAM.gov')}:${normalized(candidate.noticeId || candidate.solicitationNumber)}` }

function defaults() {
  return {
    monitoringEnabled: true, departmentRule: 'Exact', agencyRule: 'Exact', pocRule: 'Exact',
    titleOverlapPercent: 40, noticeTypes: 'RFP, RFQ', submissionWindowDays: 364,
    noSubmissionLookbackDays: 150, noSubmissionLookaheadDays: 150,
  }
}

function rules(input = {}) {
  const base = defaults()
  const exactOrIgnore = (value, fallback) => ['Exact', 'Ignore'].includes(clean(value)) ? clean(value) : fallback
  return {
    monitoringEnabled: boolean(input.monitoringEnabled, base.monitoringEnabled),
    departmentRule: exactOrIgnore(input.departmentRule, base.departmentRule),
    agencyRule: exactOrIgnore(input.agencyRule, base.agencyRule),
    pocRule: exactOrIgnore(input.pocRule, base.pocRule),
    titleOverlapPercent: number(input.titleOverlapPercent, base.titleOverlapPercent, 1, 100),
    noticeTypes: 'RFP, RFQ',
    submissionWindowDays: number(input.submissionWindowDays, base.submissionWindowDays, 1, 364),
    noSubmissionLookbackDays: number(input.noSubmissionLookbackDays, base.noSubmissionLookbackDays, 0, 364),
    noSubmissionLookaheadDays: number(input.noSubmissionLookaheadDays, base.noSubmissionLookaheadDays, 0, 364),
  }
}

function normalizeDecision(decision) {
  return {
    noticeId: clean(decision?.noticeId || decision?.['Follow-up Notice ID']),
    solicitationNumber: clean(decision?.solicitationNumber || decision?.['Follow-up Solicitation Number']),
    decision: clean(decision?.decision || decision?.Decision),
    source: clean(decision?.source || decision?.['Candidate Source'] || 'SAM.gov'),
  }
}

function canonicalDecisions(decisions = []) {
  return decisions
    .map(normalizeDecision)
    .sort((left, right) => `${candidateKey(left)}:${left.decision}`.localeCompare(`${candidateKey(right)}:${right.decision}`))
}

function normalizeWatch(input, existing = null) {
  const opportunityId = clean(input.opportunityId || input.contractNumber || input['Opportunity ID'])
  const source = {
    department: clean(input.department), agency: clean(input.agency), office: clean(input.office),
    naicsCode: clean(input.naicsCode), pocEmail: clean(input.pocEmail),
    title: clean(input.title), noticeId: clean(input.noticeId || opportunityId),
    solicitationNumber: clean(input.solicitationNumber), submissionDate: clean(input.submissionDate),
    rules: rules(input.rules), titleMatcherVersion: TITLE_MATCHER_VERSION,
  }
  const sourceFingerprint = hash(JSON.stringify(source))
  const changed = existing?.sourceFingerprint && existing.sourceFingerprint !== sourceFingerprint
  const decisions = canonicalDecisions(input.decisions)
  const inputFingerprint = hash(JSON.stringify({
    opportunityId,
    rowIndex: Number(input.rowIndex ?? input._rowIndex),
    source,
    decisions,
  }))
  return {
    ...(existing || {}),
    key: existing?.key || watchKey(opportunityId),
    opportunityId, rowIndex: Number(input.rowIndex ?? input._rowIndex), source, sourceFingerprint,
    decisions,
    inputFingerprint,
    // Keep the last verified candidates visible while changed criteria or
    // newly loaded contact data wait for the next check. Clearing them here
    // made a result appear briefly on page load and then disappear.
    ...(changed ? { lastCheckedAt: null, seenUntil: null, needsCheck: true } : {}),
  }
}

async function readWatch(env, key) {
  const value = await env.CACHE.get(key)
  try { return value ? JSON.parse(value) : null } catch { return null }
}
async function writeWatch(env, watch) { await env.CACHE.put(watch.key, JSON.stringify(watch)) }
async function listWatches(env) {
  const list = await env.CACHE.list({ prefix: WATCH_PREFIX, limit: 1000 })
  return (await Promise.all(list.keys.map((item) => readWatch(env, item.name)))).filter(Boolean)
}

function decisionFor(watch, candidate) {
  const id = normalized(candidate.noticeId || candidate.solicitationNumber)
  const source = normalized(candidate.source || 'SAM.gov')
  return watch.decisions?.find((entry) =>
    (!entry.source || normalized(entry.source) === source) && (
      (entry.noticeId && normalized(entry.noticeId) === id) ||
      (entry.solicitationNumber && normalized(entry.solicitationNumber) === id)
    )
  )?.decision || ''
}

function publicWatch(watch) {
  const candidates = (watch.candidates || []).map((candidate) => ({ ...candidate, decision: decisionFor(watch, candidate) }))
  const pendingCount = candidates.filter((candidate) => !candidate.decision).length
  return {
    opportunityId: watch.opportunityId, rowIndex: watch.rowIndex, rules: watch.source?.rules || defaults(),
    candidates, matchCount: candidates.length, pendingCount,
    badgeVisible: pendingCount > 0,
    badgeState: pendingCount === 0 ? 'none' : 'active',
    seenUntil: null, lastCheckedAt: watch.lastCheckedAt || null, lastError: watch.lastError || null,
    source: watch.source,
  }
}

async function durablePublicWatch(env, watch) {
  const result = watch && Object.hasOwn(watch, 'matchCount') ? watch : publicWatch(watch)
  if (!env.EBUY_DB || !(await alertStorageReady(env.EBUY_DB))) return result
  const alert = await getOpportunityAlert(env.EBUY_DB, watch.opportunityId, 'rfi_follow_on')
  const durableCandidates = Array.isArray(alert?.details?.candidates) ? alert.details.candidates : []
  const hydrated = (!result.candidates?.length && durableCandidates.length)
    ? {
        ...result,
        candidates: durableCandidates,
        matchCount: durableCandidates.length,
        pendingCount: durableCandidates.length,
        badgeVisible: alert.badgeVisible,
        badgeState: alert.badgeVisible ? 'active' : 'acknowledged',
      }
    : result
  if (alert?.status === 'active' && alert.badgeVisible === false) {
    return { ...hydrated, badgeVisible: false, badgeState: 'acknowledged' }
  }
  return hydrated
}

async function durableWatches(env, watches) {
  return Promise.all((watches || []).map((watch) => durablePublicWatch(env, watch)))
}

async function writeStatusSnapshot(env, watches) {
  return persistStatusSnapshot(env, {
    watches: watches.map(publicWatch),
    updatedAt: new Date().toISOString(),
  })
}

async function readStatusSnapshot(env) {
  try {
    const value = await env.CACHE.get(STATUS_SNAPSHOT_KEY)
    if (!value) return null
    const snapshot = JSON.parse(value)
    return Array.isArray(snapshot?.watches) ? snapshot : null
  } catch (error) {
    console.warn(JSON.stringify({
      event: 'rfi_followup_status_snapshot_read_failed',
      message: error.message,
    }))
    return null
  }
}

async function persistStatusSnapshot(env, snapshot) {
  try {
    await env.CACHE.put(STATUS_SNAPSHOT_KEY, JSON.stringify(snapshot))
    return true
  } catch (error) {
    // This is a read optimization, not the source of truth. KV quota,
    // propagation, or serialization problems must never break the status API.
    console.warn(JSON.stringify({
      event: 'rfi_followup_status_snapshot_write_failed',
      message: error.message,
    }))
    return false
  }
}

async function readRunStatus(env) {
  try {
    return await env.CACHE.get(RUN_KEY, 'json')
  } catch (error) {
    console.warn(JSON.stringify({
      event: 'rfi_followup_run_status_read_failed',
      message: error.message,
    }))
    return null
  }
}

async function updateStatusSnapshotEntry(env, watch) {
  const snapshot = await readStatusSnapshot(env)
  if (!snapshot) return
  const next = publicWatch(watch)
  const index = snapshot.watches.findIndex((item) =>
    normalized(item.opportunityId) === normalized(next.opportunityId)
  )
  if (index >= 0) snapshot.watches[index] = next
  else snapshot.watches.push(next)
  snapshot.updatedAt = new Date().toISOString()
  await persistStatusSnapshot(env, snapshot)
}

async function syncDurableFollowOnAlert(env, watch) {
  if (!env.EBUY_DB || !(await alertStorageReady(env.EBUY_DB))) return
  const pending = (watch.candidates || []).filter((candidate) => !decisionFor(watch, candidate))
  if (pending.length) {
    await upsertOpportunityAlert(env.EBUY_DB, {
      opportunityKey: watch.opportunityId,
      type: 'rfi_follow_on',
      fingerprint: alertFingerprint(pending.map((candidate) => ({ id: candidateKey(candidate) }))),
      summary: `${pending.length} possible RFP or RFQ follow-on${pending.length === 1 ? '' : 's'} found`,
      details: { candidates: pending.map((candidate) => ({ source: candidate.source || 'SAM.gov', noticeId: candidate.noticeId, noticeType: candidate.noticeType, title: candidate.title, matchScore: candidate.matchScore, confidence: candidate.confidence, detailUrl: candidate.detailUrl || candidate.samLink || '' })) },
    })
  } else if (watch.resultFingerprint) {
    await resolveOpportunityAlert(env.EBUY_DB, watch.opportunityId, 'rfi_follow_on')
  }
}

function eBuyCandidateAsSAM(candidate) {
  return {
    noticeId: candidate.requestId,
    solicitationNumber: candidate.referenceNumber || candidate.requestId,
    title: candidate.title,
    description: candidate.description,
    fullParentPathName: [candidate.buyerDepartment, candidate.buyerAgency].filter(Boolean).join('.'),
    pointOfContact: candidate.buyerEmail ? [{ fullName: candidate.buyerName, email: candidate.buyerEmail, phone: candidate.buyerPhone }] : [],
    postedDate: candidate.postedAt,
    responseDeadLine: candidate.closesAt,
    type: candidate.requestType === 'RFQ' ? 'k' : 'o',
    baseType: candidate.requestType,
    typeOfSetAsideDescription: candidate.setAsideType,
    uiLink: '',
  }
}

function samNewTabRowAsRecord(row) {
  const contacts = clean(row['Point of Contact'] || row.POC || row['Contracting Officer / Specialist (POC)*'])
  return {
    noticeId: clean(row['Notice ID']),
    solicitationNumber: clean(row['Solicitation Number']),
    title: clean(row.Title || row['Project Title / Description*']),
    description: clean(row.Description),
    fullParentPathName: [row.Department, row.Agency, row.Office].map(clean).filter(Boolean).join('.'),
    pointOfContact: contacts ? [{ fullName: contacts, email: clean(row['POC Email'] || row.Email) }] : [],
    postedDate: workbookDate(row['Posted Date'] || row['Date Added']),
    responseDeadLine: workbookDate(row['Response Deadline'] || row['Response Date']),
    type: clean(row['Notice Type']),
    baseType: clean(row['Notice Type']),
    typeOfSetAsideDescription: clean(row['Set Aside'] || row['Set-Aside']),
    uiLink: clean(row['SAM.gov URL']),
  }
}

export function findLocalSAMFollowUps(rows, source) {
  return (rows || []).map((row) => {
    const noticeType = clean(row['Notice Type']).toUpperCase()
    if (!noticeType.includes('RFP') && !noticeType.includes('RFQ')) return null
    const match = followUpCandidate(samNewTabRowAsRecord(row), source)
    return match ? { ...match, source: 'SAM.gov', detailUrl: match.samLink || clean(row['SAM.gov URL']) } : null
  }).filter(Boolean)
}

function dateWindow(source) {
  const submission = Date.parse(source.submissionDate || '')
  if (Number.isFinite(submission)) {
    return {
      postedAfter: new Date(submission).toISOString(),
      postedBefore: new Date(submission + Number(source.rules?.submissionWindowDays || 364) * DAILY_MS).toISOString(),
    }
  }
  const now = Date.now()
  return {
    postedAfter: new Date(now - Number(source.rules?.noSubmissionLookbackDays || 150) * DAILY_MS).toISOString(),
    postedBefore: new Date(now + Number(source.rules?.noSubmissionLookaheadDays || 150) * DAILY_MS).toISOString(),
  }
}

async function findCrossSourceFollowUps(env, watch, samNewTabRows = []) {
  const eBuySource = env.EBUY_DB ? await findEbuyPipelineSource(env.EBUY_DB, watch.opportunityId) : null
  const source = eBuySource ? {
    ...watch.source,
    title: watch.source.title || eBuySource.title,
    department: watch.source.department || eBuySource.buyerDepartment,
    agency: watch.source.agency || eBuySource.buyerAgency,
    pocEmail: watch.source.pocEmail || eBuySource.buyerEmail,
    noticeId: eBuySource.requestId,
    solicitationNumber: eBuySource.referenceNumber || watch.source.solicitationNumber,
  } : watch.source
  // eBuy is part of the New tab candidate pool regardless of where the
  // original pipeline opportunity came from.
  const candidates = await findLocalEbuyFollowUps(env, watch) || []
  // SAM candidates come from NewOpportunitiesTable, which the normal pull has
  // already populated. Do not issue a separate SAM search for every watch.
  candidates.push(...findLocalSAMFollowUps(samNewTabRows, source))
  const unique = new Map()
  for (const candidate of candidates) {
    const family = normalized(candidate.solicitationNumber || candidate.noticeId).replace(/[^a-z0-9]/g, '')
    const key = family || candidateKey(candidate)
    const current = unique.get(key)
    if (!current || Number(candidate.matchScore || 0) > Number(current.matchScore || 0) || (candidate.source === 'GSA eBuy' && current.source !== 'GSA eBuy')) unique.set(key, candidate)
  }
  return [...unique.values()].sort((left, right) => Number(right.matchScore || 0) - Number(left.matchScore || 0))
}

async function findLocalEbuyFollowUps(env, watch) {
  if (!env.EBUY_DB) return null
  const eBuySource = await findEbuyPipelineSource(env.EBUY_DB, watch.opportunityId)
  const source = {
    ...watch.source,
    title: watch.source.title || eBuySource?.title,
    department: watch.source.department || eBuySource?.buyerDepartment,
    agency: watch.source.agency || eBuySource?.buyerAgency,
    pocEmail: watch.source.pocEmail || eBuySource?.buyerEmail,
    noticeId: eBuySource?.requestId || watch.source.noticeId,
    solicitationNumber: eBuySource?.referenceNumber || watch.source.solicitationNumber,
  }
  const archived = await listEbuyFollowOnCandidates(env.EBUY_DB, dateWindow(source))
  return archived.map((opportunity) => {
    const match = followUpCandidate(eBuyCandidateAsSAM(opportunity), source)
    return match ? {
      ...match,
      source: 'GSA eBuy',
      detailUrl: `/opportunities/ebuy/${encodeURIComponent(opportunity.requestId)}`,
      samLink: '',
    } : null
  }).filter(Boolean)
}

export async function refreshEbuyFollowOnWatches(env) {
  if (!env.CACHE || !env.EBUY_DB) return { checked: 0, changed: 0 }
  const watches = await listWatches(env)
  let checked = 0
  let changed = 0
  for (const watch of watches) {
    if (!watch.source?.rules?.monitoringEnabled) continue
    const local = await findLocalEbuyFollowUps(env, watch)
    if (!local) continue
    checked++
    const previousSam = (watch.candidates || []).filter((candidate) => (candidate.source || 'SAM.gov') !== 'GSA eBuy')
    const candidates = [...local, ...previousSam]
    const fingerprint = hash(candidates.map(candidateKey).sort().join('|'))
    if (fingerprint !== watch.resultFingerprint) changed++
    watch.candidates = candidates
    watch.resultFingerprint = fingerprint
    watch.lastCheckedAt = new Date().toISOString()
    watch.lastError = null
    watch.needsCheck = false
    await writeWatch(env, watch)
    await syncDurableFollowOnAlert(env, watch)
  }
  if (checked) await writeStatusSnapshot(env, watches)
  return { checked, changed }
}

async function checkWatch(env, watch, samNewTabRows = [], { persist = true } = {}) {
  if (!watch.source?.rules?.monitoringEnabled) return watch
  try {
    const candidates = await findCrossSourceFollowUps(env, watch, samNewTabRows)
    const fingerprint = hash(candidates.map(candidateKey).sort().join('|'))
    watch.candidates = candidates
    watch.resultFingerprint = fingerprint
    watch.lastCheckedAt = new Date().toISOString()
    watch.lastError = null
    watch.needsCheck = false
    await syncDurableFollowOnAlert(env, watch)
  } catch (error) {
    watch.lastCheckedAt = new Date().toISOString()
    watch.lastError = error.message
  }
  if (persist) await writeWatch(env, watch)
  return watch
}

async function syncWatches(env, inputs, { replace = false } = {}) {
  const existing = await listWatches(env)
  const finalWatches = new Map(existing.map((watch) => [watch.key, watch]))
  const incomingKeys = new Set()
  const written = []
  let unchanged = 0
  for (const input of inputs) {
    const opportunityId = clean(input.opportunityId || input.contractNumber || input['Opportunity ID'])
    if (!opportunityId) continue
    const key = watchKey(opportunityId)
    incomingKeys.add(key)
    const previous = existing.find((watch) => watch.key === key) || null
    const watch = normalizeWatch(input, previous)
    // This path runs from browser synchronization and, when configured,
    // app-only Graph reads. Do not rewrite a watch simply because a page was
    // opened or a scheduled sync ran.
    if (!previous || previous.inputFingerprint !== watch.inputFingerprint) {
      watch.syncedAt = new Date().toISOString()
      await writeWatch(env, watch)
      await syncDurableFollowOnAlert(env, watch)
      written.push(watch)
      finalWatches.set(watch.key, watch)
    } else {
      unchanged++
    }
  }
  if (replace) {
    const removed = existing.filter((watch) => !incomingKeys.has(watch.key))
    await Promise.all(removed.map((watch) => env.CACHE.delete(watch.key)))
    if (env.EBUY_DB && await alertStorageReady(env.EBUY_DB)) {
      await Promise.all(removed.map(async (watch) => {
        const alert = await getOpportunityAlert(env.EBUY_DB, watch.opportunityId, 'rfi_follow_on')
        if (alert?.status === 'active') await resolveOpportunityAlert(env.EBUY_DB, watch.opportunityId, 'rfi_follow_on')
      }))
    }
    removed.forEach((watch) => finalWatches.delete(watch.key))
    if (removed.length || written.length) await writeStatusSnapshot(env, [...finalWatches.values()])
  } else if (written.length) {
    await writeStatusSnapshot(env, [...finalWatches.values()])
  }
  return { written, unchanged, watches: [...finalWatches.values()] }
}

async function appOnlyToken(env) {
  if (env.RFI_FOLLOW_UP_APP_ONLY !== 'true' || !env.MS_TENANT_ID || !env.MS_CLIENT_ID || !env.MS_CLIENT_SECRET || !env.WORKBOOK_ID) return null
  return getAppOnlyGraphToken(env)
}

async function graphRows(env, token, tableName) {
  return readWorkbookTable(env, DRIVE_ID, token, tableName)
}

function appSettings(rows) {
  const settings = Object.fromEntries(rows.map((row) => [clean(row.Setting), row.Value]))
  return rules({
    monitoringEnabled: settings['RFI Follow-up Monitoring'], departmentRule: settings['RFI Follow-up Department Rule'],
    agencyRule: settings['RFI Follow-up Agency Rule'], pocRule: settings['RFI Follow-up POC Rule'],
    titleOverlapPercent: settings['RFI Follow-up Title Overlap %'], noticeTypes: settings['RFI Follow-up Notice Types'],
    submissionWindowDays: settings['RFI Follow-up Submission Window Days'],
    noSubmissionLookbackDays: settings['RFI Follow-up No-Submission Lookback Days'], noSubmissionLookaheadDays: settings['RFI Follow-up No-Submission Lookahead Days'],
  })
}

function effectiveRules(globalRules, override) {
  if (!override || !boolean(override['Monitoring Enabled'], true)) return { ...globalRules, monitoringEnabled: Boolean(!override || boolean(override['Monitoring Enabled'], true)) }
  if (boolean(override['Use Global Criteria'], true)) return { ...globalRules, monitoringEnabled: boolean(override['Monitoring Enabled'], true) }
  return rules({
    ...globalRules, monitoringEnabled: override['Monitoring Enabled'],
    departmentRule: override['Department Rule'] === 'Ignore' ? 'Ignore' : 'Exact',
    agencyRule: override['Agency Rule'] === 'Ignore' ? 'Ignore' : 'Exact',
    pocRule: override['POC Rule'] === 'Ignore' ? 'Ignore' : 'Exact',
    titleOverlapPercent: override['Title Overlap %'] || globalRules.titleOverlapPercent,
    noticeTypes: 'RFP, RFQ',
    submissionWindowDays: override['Submission Window Days'] || globalRules.submissionWindowDays,
    noSubmissionLookbackDays: override['No-Submission Lookback Days'] || globalRules.noSubmissionLookbackDays,
    noSubmissionLookaheadDays: override['No-Submission Lookahead Days'] || globalRules.noSubmissionLookaheadDays,
  })
}

async function syncFromWorkbook(env) {
  const token = await appOnlyToken(env)
  if (!token) return null
  const [pipeline, contacts, settingsRows, overrides, decisions, newOpportunities] = await Promise.all([
    graphRows(env, token, 'PipelineTable'), graphRows(env, token, 'ContactsTable'), graphRows(env, token, 'SAMSettingsTable'),
    graphRows(env, token, 'RFIFollowUpOverridesTable'), graphRows(env, token, 'RFIFollowUpDecisionsTable'),
    graphRows(env, token, 'NewOpportunitiesTable'),
  ])
  const globalRules = appSettings(settingsRows)
  const watches = pipeline.filter(isFollowOnSourceOpportunity).map((item) => {
    const opportunityId = clean(item['Contract Number / Notice ID'])
    const override = overrides.find((row) => normalized(row['Opportunity ID']) === normalized(opportunityId))
    const names = clean(item['Contracting Officer / Specialist (POC)*']).split(',').map(clean)
    const contact = contacts.find((row) => names.includes(clean(row.Name)) && clean(row.Email))
    const r = effectiveRules(globalRules, override)
    return {
      opportunityId, title: item['Project Title / Description*'], department: override?.['Department Rule'] === 'Override' ? override['Department Override'] : item['Department*'],
      agency: override?.['Agency Rule'] === 'Override' ? override['Agency Override'] : item['Agency*'],
      office: item['Office*'], naicsCode: item['NAICS Code*'],
      pocEmail: override?.['POC Rule'] === 'Override' ? override['POC Email Override'] : contact?.Email,
      noticeId: opportunityId, solicitationNumber: item['Solicitation Number'], submissionDate: workbookDate(item['Submission Date (Response Date)*']),
      rules: r,
      decisions: decisions.filter((row) => normalized(row['Opportunity ID']) === normalized(opportunityId)),
    }
  })
  await syncWatches(env, watches, { replace: true })
  return { newOpportunities }
}

export async function runRFIFollowUpMonitor(env) {
  if (!env.CACHE) return { ok: false, skipped: true }
  let source = 'browser-sync'
  let samNewTabRows = []
  try {
    const synchronized = await syncFromWorkbook(env)
    if (synchronized) {
      source = 'new-tab'
      samNewTabRows = synchronized.newOpportunities
    }
  } catch (error) { console.warn(JSON.stringify({ event: 'rfi_followup_app_only_fallback', message: error.message })) }
  const watches = (await listWatches(env)).filter((watch) => watch.source?.rules?.monitoringEnabled)
  const now = Date.now()
  const due = watches.filter((watch) => watch.needsCheck || !watch.lastCheckedAt || now - Date.parse(watch.lastCheckedAt) >= DAILY_MS)
  const batch = due.sort((a, b) => Date.parse(a.lastCheckedAt || 0) - Date.parse(b.lastCheckedAt || 0)).slice(0, BATCH_SIZE)
  if (!batch.length) return { ok: true, status: 'success', source, total: watches.length, due: 0, checked: 0, skipped: true }
  await Promise.all(batch.map((watch) => checkWatch(env, watch, samNewTabRows)))
  const run = { status: 'success', checkedAt: new Date().toISOString(), source, total: watches.length, due: Math.max(0, due.length - batch.length), checked: batch.length }
  // One result write only when a real batch ran. Previously this wrote a
  // running and success record every hour, including no-op hours.
  await Promise.all([
    putAutomationRun(env, RUN_KEY, run),
    writeStatusSnapshot(env, watches),
  ])
  return { ok: true, ...run }
}

export async function handleRFIFollowUpMonitor(req, env) {
  const path = new URL(req.url).pathname
  if (!env.CACHE) return json({ error: 'CACHE binding is not configured' }, 503)
  if (path === '/sam/follow-up-monitor/sync' && req.method === 'POST') {
    const body = await req.json()
    const watches = Array.isArray(body.watches) ? body.watches : []
    if (watches.length > 500) return json({ error: 'Too many RFIs to synchronize' }, 400)
    const result = await syncWatches(env, watches, { replace: body.replace === true })
    return json({ ok: true, synchronized: result.written.length, unchanged: result.unchanged })
  }
  if (path === '/sam/follow-up-monitor/status' && req.method === 'GET') {
    const [snapshot, run] = await Promise.all([
      readStatusSnapshot(env),
      readRunStatus(env),
    ])
    if (snapshot) return json({ watches: await durableWatches(env, snapshot.watches), run: run || null })
    try {
      const watches = await listWatches(env)
      await writeStatusSnapshot(env, watches)
      return json({ watches: await durableWatches(env, watches), run: run || null })
    } catch (error) {
      console.warn(JSON.stringify({
        event: 'rfi_followup_status_fallback_failed',
        message: error.message,
      }))
      return json({ watches: [], run: run || null, temporarilyUnavailable: true })
    }
  }
  if (path === '/sam/follow-up-monitor/check-one' && req.method === 'POST') {
    const body = await req.json()
    let storedWatch = null
    try {
      storedWatch = await readWatch(env, watchKey(body.opportunityId))
    } catch (error) {
      console.warn(JSON.stringify({ event: 'rfi_followup_manual_watch_read_failed', message: error.message }))
    }
    const watch = body.watch ? normalizeWatch(body.watch, storedWatch) : storedWatch
    if (!watch) return json({ error: 'Follow-up watch not found. Synchronize this RFI first.' }, 404)
    const samNewTabRows = Array.isArray(body.newTabRows) ? body.newTabRows.slice(0, 1000) : []
    await checkWatch(env, watch, samNewTabRows, { persist: false })
    let persisted = true
    try {
      await writeWatch(env, watch)
    } catch (error) {
      persisted = false
      console.warn(JSON.stringify({ event: 'rfi_followup_manual_watch_write_failed', message: error.message }))
    }
    try {
      if (persisted) await updateStatusSnapshotEntry(env, watch)
    } catch (error) {
      console.warn(JSON.stringify({ event: 'rfi_followup_manual_snapshot_update_failed', message: error.message }))
    }
    const publicResult = await durablePublicWatch(env, watch)
    if (watch.lastError) return json({ error: watch.lastError, watch: publicResult, persisted }, 502)
    return json({ ok: true, watch: publicResult, persisted })
  }
  if (path === '/sam/follow-up-monitor/seen' && req.method === 'POST') {
    const body = await req.json()
    const watch = await readWatch(env, watchKey(body.opportunityId))
    if (!watch) return json({ error: 'Follow-up watch not found.' }, 404)
    watch.seenUntil = null
    await writeWatch(env, watch)
    if (env.EBUY_DB && await alertStorageReady(env.EBUY_DB)) {
      const alert = await env.EBUY_DB.prepare("SELECT fingerprint FROM opportunity_alerts WHERE opportunity_key = ? AND alert_type = 'rfi_follow_on'")
        .bind(watch.opportunityId).first()
      if (alert?.fingerprint) await acknowledgeOpportunityAlert(env.EBUY_DB, watch.opportunityId, 'rfi_follow_on', alert.fingerprint)
    }
    await updateStatusSnapshotEntry(env, watch)
    return json({ ok: true, watch: await durablePublicWatch(env, watch) })
  }
  return json({ error: 'Not found' }, 404)
}
