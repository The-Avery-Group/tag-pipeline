import { getAppOnlyGraphToken, graphWorkbookFetch, readWorkbookTable } from './graph.js'
import { driveIdFor } from './opportunityWorkspaceSharePoint.js'
import { partnerWorkbookValue } from './partnerWorkspaceSharePoint.js'
import { getRuntimeState, putRuntimeState } from './automationHealth.js'
import { readContractVehicleRules } from '../handlers/expiringContracts.js'
import { resolveContractVehicle } from './contractVehicleResolver.js'

export const PARTNER_VEHICLE_TABLE = 'PartnerVehiclesTable'
export const VEHICLE_HEADERS = ['Record ID', 'Partner UEI', 'Vehicle Name', 'PIID', 'Relationship', 'Current End Date', 'Potential End Date', 'Last Date to Order', 'Source Link', 'Last Seen', 'Status']
export const ENRICHMENT_HEADERS = ['Partner Group', 'USAspending Enabled', 'USAspending Agencies', 'USAspending Vehicles', 'USAspending Refreshed At']
const RUN_KEY = 'partner-enrichment:run'
const LOCK_KEY = 'partner-enrichment:lock'
const STEP = { retries: { limit: 4, delay: '30 seconds', backoff: 'exponential' }, timeout: '2 minutes' }
const clean = value => String(value || '').trim()
const ueiOf = row => clean(partnerWorkbookValue(row, 'UEI Number')).toUpperCase()
const validUEI = uei => /^[A-Z0-9]{12}$/.test(uei)
export const partnerEnrichmentEnabled = row => validUEI(ueiOf(row)) && ['', 'yes'].includes(clean(partnerWorkbookValue(row, 'USAspending Enabled')).toLowerCase())
// A batch run is shared infrastructure, not the status of every partner.
export function partnerRunStatus(run, uei, snapshot) {
  if (!run || (run.requestedUEI ? run.requestedUEI !== uei : !run.partnerUEIs?.includes(uei))) return null
  const failure = run.failures?.find(item => item.uei === uei)
  if (failure) return { ...run, status: 'needs_attention', error: failure.error, failures: [failure] }
  if (snapshot?.checkedAt === run.startedAt) return { ...run, status: 'complete', error: undefined, failures: [] }
  if (!run.requestedUEI && ['running', 'queued'].includes(run.status)) {
    return { ...run, status: run.currentUEI === uei ? 'running' : 'queued', failures: [] }
  }
  return { ...run, failures: [] }
}
const stateEnv = env => ({ ...env, CACHE: undefined }) // Never fall back to KV.
const statusRead = env => getRuntimeState(stateEnv(env), RUN_KEY, { legacyKv: false })
const statusWrite = (env, value) => putRuntimeState(stateEnv(env), RUN_KEY, value, { category: 'partner-enrichment', expirationTtl: 180 * 86400 })
export function partnerEnrichmentPeriod(at) {
  const end = new Date(at); const start = new Date(end)
  start.setUTCFullYear(start.getUTCFullYear() - 5)
  return { start_date: start.toISOString().slice(0, 10), end_date: end.toISOString().slice(0, 10) }
}
export function agencyEvidence(records, uei) {
  const agencies = new Map()
  for (const row of records) {
    if (clean(row['Recipient UEI']).toUpperCase() !== uei) throw new Error('USAspending recipient identity could not be verified; previous data retained')
    const name = clean(row['Funding Sub Agency'] || row['Funding Agency'] || row['Awarding Sub Agency'] || row['Awarding Agency'])
    if (!name) continue
    const existing = agencies.get(name) || { name, source: row['Funding Sub Agency'] || row['Funding Agency'] ? 'funding' : 'awarding', awardIds: [] }
    if (row.generated_internal_id && existing.awardIds.length < 5) existing.awardIds.push(row.generated_internal_id)
    agencies.set(name, existing)
  }
  return [...agencies.values()]
}
export function vehicleRecord(detail, uei, rules, checkedAt) {
  if (clean(detail.recipient?.recipient_uei).toUpperCase() !== uei) throw new Error('Vehicle recipient differs from the partner UEI')
  const piid = clean(detail.piid)
  if (!piid || detail.category !== 'idv') throw new Error('USAspending did not return a parent vehicle record')
  const id = clean(detail.generated_unique_award_id)
  if (!id) throw new Error('Vehicle source identifier is missing')
  const resolution = resolveContractVehicle(piid, rules)
  const dates = detail.period_of_performance || {}
  return {
    'Record ID': `${uei}:${id}`, 'Partner UEI': uei,
    'Vehicle Name': resolution.vehicleName || '', PIID: piid,
    Relationship: 'Direct award recipient',
    'Current End Date': clean(dates.end_date).slice(0, 10),
    'Potential End Date': clean(dates.potential_end_date).slice(0, 10),
    'Last Date to Order': clean(dates.last_date_to_order || detail.last_date_to_order || detail.latest_transaction_contract_data?.last_date_to_order).slice(0, 10),
    'Source Link': `https://www.usaspending.gov/award/${encodeURIComponent(id)}`,
    'Last Seen': checkedAt, Status: 'Reported; ordering eligibility not verified',
  }
}
export async function fetchPartnerUsaspending(path, body) {
  // The request and body read share a deadline below the two-minute step timeout.
  // Workflow steps own retries; do not add another retry loop here.
  const signal = AbortSignal.timeout(60_000)
  try {
    const response = await fetch(`https://api.usaspending.gov/api/v2${path}`, {
      method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}), signal,
    })
    if (!response.ok) throw new Error(`USAspending request failed (${response.status}); previous snapshot retained`)
    const data = await response.json()
    if (body && (!Array.isArray(data.results) || typeof data.page_metadata?.hasNext !== 'boolean')) throw new Error('USAspending returned an incomplete page')
    return data
  } catch (error) {
    if (signal.aborted || error.name === 'TimeoutError') {
      throw new Error('USAspending did not respond within 60 seconds. Previously saved information is unchanged. Try Refresh USAspending again later.', { cause: error })
    }
    throw error
  }
}
async function context(env) { return { token: await getAppOnlyGraphToken(env), driveId: driveIdFor(env) } }
function letter(index) { let out = ''; for (let n = index + 1; n; n = Math.floor((n - 1) / 26)) out = String.fromCharCode(65 + (n - 1) % 26) + out; return out }
async function headersFor(env, ctx, table) {
  const data = await graphWorkbookFetch(env, ctx.driveId, ctx.token, `/tables/${table}/columns`)
  return data.value.map(c => c.name)
}
async function ensureSchema(env) {
  const ctx = await context(env)
  const headers = await headersFor(env, ctx, 'PartnersTable')
  for (const name of ENRICHMENT_HEADERS) {
    if (!headers.includes(name)) await graphWorkbookFetch(env, ctx.driveId, ctx.token, '/tables/PartnersTable/columns', { method: 'POST', body: JSON.stringify({ name }) })
  }
  try { await headersFor(env, ctx, PARTNER_VEHICLE_TABLE); return }
  catch (error) { if (error.status !== 404) throw error }
  // Never overwrite an existing worksheet in order to create the table.
  const sheet = await graphWorkbookFetch(env, ctx.driveId, ctx.token, '/worksheets/add', {
    method: 'POST', body: JSON.stringify({ name: `Partner vehicles ${Date.now().toString(36)}` }),
  })
  const address = `A1:${letter(VEHICLE_HEADERS.length - 1)}1`
  await graphWorkbookFetch(env, ctx.driveId, ctx.token, `/worksheets/${sheet.id}/range(address='${address}')`, { method: 'PATCH', body: JSON.stringify({ values: [VEHICLE_HEADERS] }) })
  const table = await graphWorkbookFetch(env, ctx.driveId, ctx.token, `/worksheets/${sheet.id}/tables/add`, { method: 'POST', body: JSON.stringify({ address, hasHeaders: true }) })
  await graphWorkbookFetch(env, ctx.driveId, ctx.token, `/tables/${table.id}`, { method: 'PATCH', body: JSON.stringify({ name: PARTNER_VEHICLE_TABLE }) })
}
async function partnerRows(env) { const ctx = await context(env); return readWorkbookTable(env, ctx.driveId, ctx.token, 'PartnersTable') }
async function enabledPartner(env, uei) {
  const matches = (await partnerRows(env)).filter(row => ueiOf(row) === uei)
  if (matches.length !== 1) throw new Error('Partner UEI is missing or duplicated; refresh stopped')
  if (!partnerEnrichmentEnabled(matches[0])) throw new Error('Partner enrichment is disabled')
  return matches[0]
}
// Write only machine-owned cells, never a whole user-maintained partner row.
export async function savePartnerSummary(env, uei, patch) {
  const row = await enabledPartner(env, uei)
  const ctx = await context(env)
  const [headers, range, sheet] = await Promise.all([
    headersFor(env, ctx, 'PartnersTable'),
    graphWorkbookFetch(env, ctx.driveId, ctx.token, '/tables/PartnersTable/range'),
    graphWorkbookFetch(env, ctx.driveId, ctx.token, '/tables/PartnersTable/worksheet'),
  ])
  for (const [name, value] of Object.entries(patch)) {
    if (!['USAspending Agencies', 'USAspending Vehicles', 'USAspending Refreshed At'].includes(name)) throw new Error('Unsafe partner update')
    if (clean(row[name]) === value) continue
    if (value.length > 32000) throw new Error('Partner summary exceeds workbook cell capacity')
    const column = headers.indexOf(name)
    if (column < 0) throw new Error(`Missing ${name}`)
    const cell = `${letter(range.columnIndex + column)}${range.rowIndex + row._rowIndex + 2}`
    await graphWorkbookFetch(env, ctx.driveId, ctx.token, `/worksheets/${sheet.id}/range(address='${cell}')`, { method: 'PATCH', body: JSON.stringify({ values: [[value]] }) })
  }
}
async function saveVehicles(env, uei, vehicles, checkedAt) {
  await enabledPartner(env, uei)
  const ctx = await context(env)
  const headers = await headersFor(env, ctx, PARTNER_VEHICLE_TABLE)
  if (VEHICLE_HEADERS.some(h => !headers.includes(h))) throw new Error('Partner vehicle table schema is incomplete')
  const rows = await readWorkbookTable(env, ctx.driveId, ctx.token, PARTNER_VEHICLE_TABLE)
  const indexed = new Map(rows.map(row => [row['Record ID'], row]))
  for (const record of vehicles) {
    const old = indexed.get(record['Record ID'])
    const merged = { ...old, ...record }
    const values = headers.map(h => merged[h] ?? '')
    if (old && headers.every((h, i) => String(old[h] ?? '') === String(values[i]))) continue
    await graphWorkbookFetch(env, ctx.driveId, ctx.token, old ? `/tables/${PARTNER_VEHICLE_TABLE}/rows/itemAt(index=${old._rowIndex})` : `/tables/${PARTNER_VEHICLE_TABLE}/rows/add`, {
      method: old ? 'PATCH' : 'POST', body: JSON.stringify(old ? { values: [values] } : { index: null, values: [values] }),
    })
  }
  // Keep historical records. A missing result does not prove that access ended.
  return { checkedAt, count: vehicles.length }
}
export async function getPartnerEnrichment(env, uei = '') {
  const status = await statusRead(env)
  if (status?.instanceId && ['queued', 'running'].includes(status.status) && env.PARTNER_ENRICHMENT_WORKFLOW) {
    const instance = await env.PARTNER_ENRICHMENT_WORKFLOW.get(status.instanceId)
    const actual = await instance.status().catch(() => null)
    if (actual && ['errored', 'terminated'].includes(actual.status)) status.status = 'needs_attention'
    if (actual?.status === 'complete') status.status = status.failures?.length ? 'needs_attention' : 'complete'
  }
  if (!uei) return { status }
  if (!validUEI(uei)) throw new Error('A 12-character UEI is required')
  const snapshot = await getRuntimeState(stateEnv(env), `partner-enrichment:snapshot:${uei}`, { legacyKv: false })
  return { status: partnerRunStatus(status, uei, snapshot), snapshot, busy: ['running', 'queued'].includes(status?.status) }
}
export async function startPartnerEnrichment(env, { scheduledTime, uei = '' } = {}) {
  if (!env.EBUY_DB || !env.PARTNER_ENRICHMENT_WORKFLOW) throw new Error('Partner enrichment bindings are not deployed')
  if (uei) { if (!validUEI(uei)) throw new Error('A 12-character UEI is required'); await enabledPartner(env, uei) }
  const at = new Date(scheduledTime || Date.now()).toISOString()
  const quarter = `${at.slice(0, 4)}-${Math.floor(new Date(at).getUTCMonth() / 3) + 1}`
  const prior = await statusRead(env)
  if (scheduledTime && prior?.completedQuarter === quarter) return { status: 'already_completed' }
  if (prior?.instanceId) {
    const current = await env.PARTNER_ENRICHMENT_WORKFLOW.get(prior.instanceId)
    const state = await current.status().catch(error => {
      // Completed Workflow instances can age out before the next quarter.
      if (/not found|does not exist/i.test(error.message)) return { status: 'terminated' }
      throw error
    })
    if (state && !['complete', 'errored', 'terminated'].includes(state.status)) {
      if (uei && prior.requestedUEI !== uei && !prior.partnerUEIs?.includes(uei)) throw new Error('Another partner refresh is in progress. Wait for it to finish, then refresh this partner.')
      return { ...prior, reused: true }
    }
  }
  const id = `partner-enrichment-${crypto.randomUUID()}`
  // Atomic D1 lease prevents simultaneous manual/quarterly runs, including the
  // interval before a new Workflow has started. Missing migrations fail closed.
  const now = new Date().toISOString()
  if (prior?.instanceId) {
    await env.EBUY_DB.prepare('DELETE FROM crm_runtime_state WHERE state_key = ? AND payload_json = ?').bind(LOCK_KEY, JSON.stringify({ instanceId: prior.instanceId })).run()
  }
  const lock = await env.EBUY_DB.prepare(`INSERT INTO crm_runtime_state (state_key, category, payload_json, expires_at, created_at, updated_at)
    VALUES (?, 'partner-enrichment-lock', ?, ?, ?, ?)
    ON CONFLICT(state_key) DO UPDATE SET payload_json=excluded.payload_json, expires_at=excluded.expires_at, updated_at=excluded.updated_at
    WHERE crm_runtime_state.expires_at <= excluded.updated_at`).bind(LOCK_KEY, JSON.stringify({ instanceId: id }), new Date(Date.now() + 86400000).toISOString(), now, now).run()
  if (!lock.meta?.changes) throw new Error('A partner refresh is starting. Check status and try again shortly.')
  await statusWrite(env, { instanceId: id, status: 'queued', startedAt: at, requestedUEI: uei })
  try { await env.PARTNER_ENRICHMENT_WORKFLOW.createBatch([{ id, params: { at, quarter, uei, scheduled: Boolean(scheduledTime) } }]) }
  catch (error) {
    await env.EBUY_DB.prepare('DELETE FROM crm_runtime_state WHERE state_key = ? AND payload_json = ?').bind(LOCK_KEY, JSON.stringify({ instanceId: id })).run()
    await statusWrite(env, { instanceId: id, status: 'needs_attention', error: error.message })
    throw error
  }
  return { instanceId: id, status: 'queued' }
}
export async function runPartnerEnrichment(env, event, step) {
  const { at, quarter, uei, scheduled } = event.payload
  const run = { instanceId: event.instanceId, startedAt: at, requestedUEI: uei, status: 'running', completed: 0, failures: [] }
  try {
    await step.do('schema', STEP, () => ensureSchema(env))
    const partners = await step.do('partners', STEP, async () => {
      const rows = await partnerRows(env)
      const selected = rows.filter(row => partnerEnrichmentEnabled(row) && (!uei || ueiOf(row) === uei)).map(row => ({ uei: ueiOf(row), name: clean(partnerWorkbookValue(row, 'Partner Name')) }))
      if (new Set(selected.map(p => p.uei)).size !== selected.length) throw new Error('Duplicate partner UEIs must be resolved before enrichment')
      return selected
    })
    const rules = await step.do('vehicle rules', STEP, () => readContractVehicleRules(env))
    run.partnerUEIs = partners.map(partner => partner.uei)
    await step.do('started', () => statusWrite(env, { ...run, total: partners.length }))
    for (const partner of partners) {
      const key = partner.uei
      run.currentUEI = key
      await step.do(`${key} started`, () => statusWrite(env, { ...run, total: partners.length }))
      try {
        const agencies = new Map(); const vehicleIds = new Set()
        for (const kind of ['contracts', 'vehicles']) {
          let more = true
          for (let page = 1; more; page++) {
            if (page > 500) throw new Error('History exceeds the safe page limit; no partial snapshot published')
            const data = await step.do(`${key} ${kind} ${page}`, STEP, () => fetchPartnerUsaspending('/search/spending_by_award/', {
              filters: { recipient_search_text: [key], award_type_codes: kind === 'contracts' ? ['A', 'B', 'C', 'D'] : ['IDV_A', 'IDV_B', 'IDV_B_A', 'IDV_B_B', 'IDV_B_C', 'IDV_C', 'IDV_D', 'IDV_E'], ...(kind === 'contracts' ? { time_period: [partnerEnrichmentPeriod(at)] } : {}) },
              fields: ['Award ID', 'Recipient UEI', 'Funding Agency', 'Funding Sub Agency', 'Awarding Agency', 'Awarding Sub Agency', 'generated_internal_id'],
              limit: 100, page, sort: 'Award ID', order: 'asc', subawards: false,
            }))
            for (const evidence of agencyEvidence(data.results, key)) {
              if (kind === 'contracts' && !agencies.has(evidence.name)) agencies.set(evidence.name, evidence)
            }
            if (kind === 'vehicles') for (const row of data.results) { if (!row.generated_internal_id) throw new Error('Vehicle identifier missing'); vehicleIds.add(row.generated_internal_id) }
            more = data.page_metadata.hasNext
            if (more && !data.results.length) throw new Error('Empty USAspending page marked as incomplete')
          }
        }
        const vehicles = []
        for (const id of vehicleIds) {
          const record = await step.do(`${key} vehicle ${id}`, STEP, async () => vehicleRecord(await fetchPartnerUsaspending(`/awards/${encodeURIComponent(id)}/`), key, rules, at))
          vehicles.push(record)
        }
        const snapshot = { uei: key, checkedAt: at, period: partnerEnrichmentPeriod(at), agencies: [...agencies.values()], vehicles, source: 'USAspending', vehicleScope: 'Direct IDV awards; indirect and research-only access retained separately' }
        // Workbook-first publish, then atomic D1 snapshot. Retry is idempotent.
        for (let i = 0; i < vehicles.length; i += 10) await step.do(`${key} save vehicles ${i}`, STEP, () => saveVehicles(env, key, vehicles.slice(i, i + 10), at))
        await step.do(`${key} save summary`, STEP, () => savePartnerSummary(env, key, {
          'USAspending Agencies': [...agencies.keys()].sort().join(', '),
          'USAspending Vehicles': [...new Set(vehicles.map(v => `${v['Vehicle Name'] || 'Unresolved vehicle'} (${v.PIID})`))].sort().join(', '),
          'USAspending Refreshed At': at,
        }))
        await step.do(`${key} publish`, STEP, () => putRuntimeState(stateEnv(env), `partner-enrichment:snapshot:${key}`, snapshot, { category: 'partner-enrichment-snapshot' }))
        run.completed++
      } catch (error) { run.failures.push({ uei: key, name: partner.name, error: error.message }) }
      await step.do(`${key} progress`, async () => {
        await env.EBUY_DB.prepare('UPDATE crm_runtime_state SET expires_at = ? WHERE state_key = ? AND payload_json = ?').bind(new Date(Date.now() + 86400000).toISOString(), LOCK_KEY, JSON.stringify({ instanceId: event.instanceId })).run()
        await statusWrite(env, { ...run, total: partners.length })
      })
    }
    run.status = run.failures.length ? 'needs_attention' : 'complete'
    if (scheduled && !run.failures.length) run.completedQuarter = quarter
    await step.do('finished', () => statusWrite(env, run))
    return run
  } catch (error) {
    await step.do('failed', () => statusWrite(env, { ...run, status: 'needs_attention', error: error.message }))
    throw error
  } finally {
    await step.do('release lease', () => env.EBUY_DB.prepare('DELETE FROM crm_runtime_state WHERE state_key = ? AND payload_json = ?').bind(LOCK_KEY, JSON.stringify({ instanceId: event.instanceId })).run())
  }
}
