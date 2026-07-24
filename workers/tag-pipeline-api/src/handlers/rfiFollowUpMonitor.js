import { findRFIFollowUps } from './sam.js'
import { getAppOnlyGraphToken, readWorkbookTable } from '../lib/graph.js'

const WATCH_PREFIX = 'rfi_followup_watch:'
const RUN_KEY = 'rfi_followup_monitor_run'
const BATCH_SIZE = 3
const DAILY_MS = 24 * 60 * 60 * 1000
const SEEN_MS = 12 * 60 * 60 * 1000
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
function candidateKey(candidate) { return normalized(candidate.noticeId || candidate.solicitationNumber) }

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
    noticeTypes: clean(input.noticeTypes) || base.noticeTypes,
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
    department: clean(input.department), agency: clean(input.agency), pocEmail: clean(input.pocEmail),
    title: clean(input.title), noticeId: clean(input.noticeId || opportunityId),
    solicitationNumber: clean(input.solicitationNumber), submissionDate: clean(input.submissionDate),
    rules: rules(input.rules),
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
    ...(changed ? { candidates: [], resultFingerprint: '', lastCheckedAt: null, seenUntil: null, needsCheck: true } : {}),
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
  const id = candidateKey(candidate)
  return watch.decisions?.find((entry) =>
    (entry.noticeId && normalized(entry.noticeId) === id) ||
    (entry.solicitationNumber && normalized(entry.solicitationNumber) === id)
  )?.decision || ''
}

function publicWatch(watch) {
  const candidates = (watch.candidates || []).map((candidate) => ({ ...candidate, decision: decisionFor(watch, candidate) }))
  const pendingCount = candidates.filter((candidate) => !candidate.decision).length
  const seenUntil = watch.seenUntil || null
  const seen = Boolean(seenUntil && Date.parse(seenUntil) > Date.now())
  return {
    opportunityId: watch.opportunityId, rowIndex: watch.rowIndex, rules: watch.source?.rules || defaults(),
    candidates, matchCount: candidates.length, pendingCount,
    badgeVisible: pendingCount > 0 && (!seenUntil || Date.parse(seenUntil) > Date.now()),
    badgeState: pendingCount === 0 ? 'none' : seen ? 'seen' : 'active',
    seenUntil, lastCheckedAt: watch.lastCheckedAt || null, lastError: watch.lastError || null,
    source: watch.source,
  }
}

async function checkWatch(env, watch) {
  if (!watch.source?.rules?.monitoringEnabled) return watch
  try {
    const candidates = await findRFIFollowUps(env, watch.source)
    const fingerprint = hash(candidates.map(candidateKey).sort().join('|'))
    if (watch.resultFingerprint && watch.resultFingerprint !== fingerprint) watch.seenUntil = null
    watch.candidates = candidates
    watch.resultFingerprint = fingerprint
    watch.lastCheckedAt = new Date().toISOString()
    watch.lastError = null
    watch.needsCheck = false
  } catch (error) {
    watch.lastCheckedAt = new Date().toISOString()
    watch.lastError = error.message
  }
  await writeWatch(env, watch)
  return watch
}

async function syncWatches(env, inputs, { replace = false } = {}) {
  const existing = await listWatches(env)
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
      written.push(watch)
    } else {
      unchanged++
    }
  }
  if (replace) {
    await Promise.all(existing.filter((watch) => !incomingKeys.has(watch.key)).map((watch) => env.CACHE.delete(watch.key)))
  }
  return { written, unchanged }
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
    noticeTypes: override['Notice Types'] || globalRules.noticeTypes,
    submissionWindowDays: override['Submission Window Days'] || globalRules.submissionWindowDays,
    noSubmissionLookbackDays: override['No-Submission Lookback Days'] || globalRules.noSubmissionLookbackDays,
    noSubmissionLookaheadDays: override['No-Submission Lookahead Days'] || globalRules.noSubmissionLookaheadDays,
  })
}

async function syncFromWorkbook(env) {
  const token = await appOnlyToken(env)
  if (!token) return false
  const [pipeline, contacts, settingsRows, overrides, decisions] = await Promise.all([
    graphRows(env, token, 'PipelineTable'), graphRows(env, token, 'ContactsTable'), graphRows(env, token, 'SAMSettingsTable'),
    graphRows(env, token, 'RFIFollowUpOverridesTable'), graphRows(env, token, 'RFIFollowUpDecisionsTable'),
  ])
  const globalRules = appSettings(settingsRows)
  const watches = pipeline.filter((item) => clean(item['TAG Opportunity Phase']) === 'Identified' && clean(item['Opportunity Outlook']) === 'New').map((item) => {
    const opportunityId = clean(item['Contract Number / Notice ID'])
    const override = overrides.find((row) => normalized(row['Opportunity ID']) === normalized(opportunityId))
    const names = clean(item['Contracting Officer / Specialist (POC)*']).split(',').map(clean)
    const contact = contacts.find((row) => names.includes(clean(row.Name)) && clean(row.Email))
    const r = effectiveRules(globalRules, override)
    return {
      opportunityId, title: item['Project Title / Description*'], department: override?.['Department Rule'] === 'Override' ? override['Department Override'] : item['Department*'],
      agency: override?.['Agency Rule'] === 'Override' ? override['Agency Override'] : item['Agency*'],
      pocEmail: override?.['POC Rule'] === 'Override' ? override['POC Email Override'] : contact?.Email,
      noticeId: opportunityId, solicitationNumber: item['Solicitation Number'], submissionDate: workbookDate(item['Submission Date (Response Date)*']),
      rules: r,
      decisions: decisions.filter((row) => normalized(row['Opportunity ID']) === normalized(opportunityId)),
    }
  })
  await syncWatches(env, watches, { replace: true })
  return true
}

export async function runRFIFollowUpMonitor(env) {
  if (!env.SAM_API_KEY || !env.CACHE) return { ok: false, skipped: true }
  let source = 'browser-sync'
  try { if (await syncFromWorkbook(env)) source = 'app-only' } catch (error) { console.warn(JSON.stringify({ event: 'rfi_followup_app_only_fallback', message: error.message })) }
  const watches = (await listWatches(env)).filter((watch) => watch.source?.rules?.monitoringEnabled)
  const now = Date.now()
  const due = watches.filter((watch) => watch.needsCheck || !watch.lastCheckedAt || now - Date.parse(watch.lastCheckedAt) >= DAILY_MS)
  const batch = due.sort((a, b) => Date.parse(a.lastCheckedAt || 0) - Date.parse(b.lastCheckedAt || 0)).slice(0, BATCH_SIZE)
  if (!batch.length) return { ok: true, status: 'success', source, total: watches.length, due: 0, checked: 0, skipped: true }
  await Promise.all(batch.map((watch) => checkWatch(env, watch)))
  const run = { status: 'success', checkedAt: new Date().toISOString(), source, total: watches.length, due: Math.max(0, due.length - batch.length), checked: batch.length }
  // One result write only when a real batch ran. Previously this wrote a
  // running and success record every hour, including no-op hours.
  await env.CACHE.put(RUN_KEY, JSON.stringify(run))
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
    const [watches, run] = await Promise.all([listWatches(env), env.CACHE.get(RUN_KEY, 'json')])
    return json({ watches: watches.map(publicWatch), run: run || null })
  }
  if (path === '/sam/follow-up-monitor/check-one' && req.method === 'POST') {
    const body = await req.json()
    const watch = await readWatch(env, watchKey(body.opportunityId))
    if (!watch) return json({ error: 'Follow-up watch not found. Synchronize this RFI first.' }, 404)
    await checkWatch(env, watch)
    return json({ ok: true, watch: publicWatch(watch) })
  }
  if (path === '/sam/follow-up-monitor/seen' && req.method === 'POST') {
    const body = await req.json()
    const watch = await readWatch(env, watchKey(body.opportunityId))
    if (!watch) return json({ error: 'Follow-up watch not found.' }, 404)
    const pending = (watch.candidates || []).filter((candidate) => !decisionFor(watch, candidate)).length
    if (pending > 0) watch.seenUntil = new Date(Date.now() + SEEN_MS).toISOString()
    await writeWatch(env, watch)
    return json({ ok: true, watch: publicWatch(watch) })
  }
  return json({ error: 'Not found' }, 404)
}
