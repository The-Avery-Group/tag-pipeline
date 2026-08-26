import { fetchAwards, groupByAwardFamily, latestValue, normalizeIdentifier } from './awards.js'
import { findAwardNotice } from './awards.js'
import { sendTeamsNotification } from './notify.js'
import { getAppOnlyGraphToken, graphWorkbookFetch, readWorkbookTable } from '../lib/graph.js'
import { alertFingerprint, alertStorageReady, upsertOpportunityAlert } from '../lib/opportunityAlerts.js'

const DRIVE_ID = 'b!DvVPmhUD7k2Va33gQGDdB3rFM6P2zkVNvlMvEl7p-levrO3tXf_USZvsR_Sr0bTe'
const AWARD_MONITOR_LIMIT = 20
const EXPIRATION_MONITOR_LIMIT = 15

function clean(value) { return String(value || '').trim() }
function isoDate(value) { return clean(value).slice(0, 10) }
function excelSerial(iso) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso
  const [year, month, day] = iso.split('-').map(Number)
  return Math.round(Date.UTC(year, month - 1, day) / 86400000) + 25569
}
function normalizedDate(value) {
  if (typeof value === 'number' && value > 0) return new Date((value - 25569) * 86400000).toISOString().slice(0, 10)
  return isoDate(value)
}

async function workbookContext(env) {
  const token = await getAppOnlyGraphToken(env)
  const rows = await readWorkbookTable(env, DRIVE_ID, token, 'PipelineTable', { pageSize: 250 })
  return { token, rows }
}

async function patchPipelineRow(env, token, row, patch) {
  const columns = await graphWorkbookFetch(env, DRIVE_ID, token, '/tables/PipelineTable/columns')
  const headers = (columns.value || []).map((column) => column.name)
  const values = headers.map((header) => {
    const value = patch[header] !== undefined ? patch[header] : row[header]
    return header === 'Contract End Date*' ? excelSerial(value) : value ?? ''
  })
  await graphWorkbookFetch(env, DRIVE_ID, token, `/tables/PipelineTable/rows/itemAt(index=${row._rowIndex})`, {
    method: 'PATCH', body: JSON.stringify({ values: [values] }),
  })
}

export async function runPendingAwardMonitor(env) {
  if (!env.SAM_API_KEY || !env.EBUY_DB || !(await alertStorageReady(env.EBUY_DB))) return { checked: 0, alerts: 0 }
  const { rows } = await workbookContext(env)
  const pending = rows.filter((row) => clean(row['TAG Opportunity Phase']) === 'Pending Award' && clean(row['Notice Type']).toUpperCase() === 'RFP')
  const cursor = Number(await env.CACHE?.get('pending_award_monitor:cursor') || 0)
  const batch = pending.slice(cursor, cursor + AWARD_MONITOR_LIMIT)
  let alerts = 0
  for (const opportunity of batch) {
    const solicitationNumber = clean(opportunity['Solicitation Number'])
    if (!solicitationNumber) continue
    const notice = await findAwardNotice(env, {
      piid: clean(opportunity['Contract Number / Notice ID']),
      solicitationNumber,
      originalSignedDate: normalizedDate(opportunity['Anticipated year for Award (MM/DD/YYYY)*']) || normalizedDate(opportunity['Submission Date (Response Date)*']) || new Date().toISOString(),
      awardeeName: '',
    })
    if (!notice?.noticeId) continue
    const tagUei = clean(env.TAG_UEI).toUpperCase()
    const awardeeUei = clean(notice.awardeeUEI).toUpperCase()
    const details = {
      awardeeName: notice.awardeeName, awardeeUEI: awardeeUei || null,
      awardNumber: notice.awardNumber, awardDate: notice.awardDate,
      awardAmount: notice.awardAmount, samLink: notice.link,
      isTagAwardee: Boolean(tagUei && awardeeUei && tagUei === awardeeUei),
      matchEvidence: notice.status,
    }
    const fingerprint = alertFingerprint({ noticeId: notice.noticeId, ...details })
    const result = await upsertOpportunityAlert(env.EBUY_DB, {
      opportunityKey: clean(opportunity['Contract Number / Notice ID']),
      type: 'award_notice', fingerprint, status: 'active',
      summary: `Possible award notice: ${notice.awardeeName || notice.awardNumber || solicitationNumber}`,
      details,
    })
    if (result.changed) {
      alerts += 1
      await sendTeamsNotification(env, 'award_notice', {
        title: opportunity['Project Title / Description*'], contractNumber: opportunity['Contract Number / Notice ID'],
        solicitationNumber, ...details,
      })
    }
  }
  const nextCursor = cursor + batch.length >= pending.length ? 0 : cursor + batch.length
  await env.CACHE?.put('pending_award_monitor:cursor', String(nextCursor))
  return { checked: batch.length, alerts, remaining: Math.max(0, pending.length - nextCursor) }
}

export async function runQuarterlyExpirationReconciliation(env, scheduledTime = Date.now()) {
  if (!env.SAM_API_KEY || !env.EBUY_DB || !(await alertStorageReady(env.EBUY_DB))) return { checked: 0, updated: 0 }
  const date = new Date(scheduledTime)
  const quarterKey = `${date.getUTCFullYear()}-Q${Math.floor(date.getUTCMonth() / 3) + 1}`
  const stateKey = 'pipeline_expiration_reconciliation:state'
  const state = await env.CACHE?.get(stateKey, 'json') || {}
  if (state.quarterKey === quarterKey && state.complete) return { skipped: true, quarterKey }
  const { token, rows } = await workbookContext(env)
  const eligible = rows.filter((row) => clean(row['Expiring Contract Number ']) || clean(row['Contract Number / Notice ID']))
  const cursor = state.quarterKey === quarterKey ? Number(state.cursor || 0) : 0
  const batch = eligible.slice(cursor, cursor + EXPIRATION_MONITOR_LIMIT)
  let updated = 0
  let review = 0
  for (const opportunity of batch) {
    const piid = clean(opportunity['Expiring Contract Number ']) || clean(opportunity['Contract Number / Notice ID'])
    const { records } = await fetchAwards(env, { piid })
    const exact = records.filter((record) => normalizeIdentifier(record?.contractId?.piid) === normalizeIdentifier(piid))
    const families = groupByAwardFamily(exact)
    const opportunityKey = clean(opportunity['Contract Number / Notice ID'])
    if (families.length !== 1) {
      if (families.length > 1) {
        review += 1
        await upsertOpportunityAlert(env.EBUY_DB, {
          opportunityKey, type: 'contract_end_date_review',
          fingerprint: alertFingerprint({ piid, families: families.length }), status: 'active',
          summary: 'Contract end date needs review', details: { piid, matchCount: families.length },
        })
      }
      continue
    }
    const currentDate = isoDate(latestValue(families[0], (record) => record?.awardDetails?.dates?.ultimateCompletionDate).value)
    if (!currentDate || currentDate === normalizedDate(opportunity['Contract End Date*'])) continue
    await patchPipelineRow(env, token, opportunity, { 'Contract End Date*': currentDate, 'Last Modified*': new Date().toISOString().slice(0, 10) })
    updated += 1
    await upsertOpportunityAlert(env.EBUY_DB, {
      opportunityKey, type: 'contract_end_date',
      fingerprint: alertFingerprint({ piid, currentDate }), status: 'active',
      summary: 'Contract end date updated', details: { piid, currentDate, source: 'SAM Contract Awards' },
    })
  }
  const nextCursor = cursor + batch.length
  const complete = nextCursor >= eligible.length
  await env.CACHE?.put(stateKey, JSON.stringify({ quarterKey, cursor: complete ? 0 : nextCursor, complete }))
  return { quarterKey, checked: batch.length, updated, review, complete }
}
