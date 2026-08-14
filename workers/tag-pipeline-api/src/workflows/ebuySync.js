import { WorkflowEntrypoint } from 'cloudflare:workers'
import {
  downloadEbuyAttachment,
  getEbuyContractToken,
  getEbuyOpportunityDetail,
  listActiveEbuyOpportunities,
  normalizeLiveEbuyOpportunity,
} from '../lib/ebuyClient.js'
import { getEbuyLiveSession } from '../lib/ebuyConnection.js'
import {
  clearEbuySyncCandidates,
  completeLiveEbuySnapshot,
  countPendingEbuySyncCandidates,
  deleteEbuyFixtureRecords,
  finishEbuySyncCandidate,
  finishEbuySyncRun,
  getArchivedEbuyAttachmentIds,
  nextEbuySyncCandidateBatch,
  recordArchivedEbuyAttachment,
  recordEbuyAttachmentFailure,
  recordEbuyConnectionResult,
  stageEbuySyncCandidates,
  startEbuySyncRun,
  syncEbuyOpportunities,
  updateEbuySyncRunProgress,
} from '../lib/ebuyRepository.js'
import { archiveEbuyFile, ensureEbuyArchiveFolder } from '../lib/sharepointArchive.js'

function mergeCounts(target, result) {
  for (const field of ['discovered', 'inserted', 'updated', 'unchanged', 'removed', 'archivedFiles']) {
    target[field] = Number(target[field] || 0) + Number(result?.[field] || 0)
  }
}

async function withContractToken(env, contractNumber, action, retry = true) {
  const session = await getEbuyLiveSession(env)
  try {
    const jwt = await getEbuyContractToken(session.accessToken, contractNumber)
    return await action(jwt)
  } catch (error) {
    if (!retry || error.code !== 'ebuy_authentication_failed') throw error
    const refreshed = await getEbuyLiveSession(env, { force: true })
    const jwt = await getEbuyContractToken(refreshed.accessToken, contractNumber)
    return action(jwt)
  }
}

async function discoverContract(env, runId, contractNumber) {
  return withContractToken(env, contractNumber, async (jwt) => {
    const records = await listActiveEbuyOpportunities(contractNumber, jwt)
    const staged = await stageEbuySyncCandidates(env.EBUY_DB, runId, contractNumber, records)
    const summaries = records
      .map((record) => normalizeLiveEbuyOpportunity(record, record?.rfq || {}, contractNumber))
      .filter((record) => record.requestId)
    const summarySync = await syncEbuyOpportunities(env.EBUY_DB, summaries, { source: 'live', completeSnapshot: false })
    return { discovered: records.length, staged, summarySync }
  })
}

async function archiveAttachments(env, record, jwt) {
  let archivedFiles = 0
  const failures = []
  const archivedIds = await getArchivedEbuyAttachmentIds(env.EBUY_DB, record.requestId)
  const pending = record.attachments.filter((attachment) => !archivedIds.has(attachment.id))
  const archiveLocation = pending.length ? await ensureEbuyArchiveFolder(env, record.requestId) : null
  for (const attachment of pending) {
    try {
      const downloaded = await downloadEbuyAttachment(record.requestId, attachment, jwt)
      const contentType = downloaded.headers.get('Content-Type') || attachment.contentType || 'application/octet-stream'
      const archived = await archiveEbuyFile(env, {
        requestId: record.requestId,
        fileName: attachment.fileName,
        contentType,
        body: downloaded.body,
        archiveLocation,
      })
      await recordArchivedEbuyAttachment(env.EBUY_DB, {
        id: attachment.id,
        requestId: record.requestId,
        fileName: attachment.fileName,
        contentType,
        byteSize: archived.size || Number(downloaded.headers.get('Content-Length') || 0),
        sourceHash: null,
        driveId: archived.driveId,
        itemId: archived.itemId,
        webUrl: archived.webUrl,
      })
      archivedFiles++
    } catch (error) {
      await recordEbuyAttachmentFailure(env.EBUY_DB, attachment.id, error.message)
      failures.push({ attachmentId: attachment.id, message: error.message })
    }
  }
  return { archivedFiles, attachmentFailures: failures }
}

function canUseDiscoveryFallback(summary, requestId, error) {
  if (error?.code === 'ebuy_authentication_failed') return false
  return Boolean((summary?.rfq?.rfqInfo?.rfqId || summary?.rfqId || requestId) && (summary?.title || summary?.rfq?.rfqInfo?.title))
}

async function processCandidateWithToken(env, runId, candidate, jwt) {
  const summary = JSON.parse(candidate.summary_json || '{}')
  let detail
  let candidateWarning = null
  try {
    detail = await getEbuyOpportunityDetail(candidate.request_id, candidate.contract_number, jwt)
  } catch (error) {
    if (!canUseDiscoveryFallback(summary, candidate.request_id, error)) throw error
    if (!summary.rfqId) summary.rfqId = candidate.request_id
    detail = summary.rfq || {}
    candidateWarning = {
      requestId: candidate.request_id,
      code: error.code || 'ebuy_detail_unavailable',
      message: `${error.message}; saved from the eBuy discovery summary and will be enriched on a later sync`,
    }
  }

  try {
    const record = normalizeLiveEbuyOpportunity(summary, detail, candidate.contract_number)
    if (candidateWarning) record.sourceDetails.detailStatus = 'summary_fallback'
    const sync = await syncEbuyOpportunities(env.EBUY_DB, [record], { source: 'live', completeSnapshot: false })
    const archive = candidateWarning ? { archivedFiles: 0, attachmentFailures: [] } : await archiveAttachments(env, record, jwt)
    await finishEbuySyncCandidate(env.EBUY_DB, runId, candidate.request_id)
    return { requestId: candidate.request_id, ...sync, ...archive, candidateWarning }
  } catch (error) {
    if (error?.code === 'ebuy_authentication_failed') throw error
    await finishEbuySyncCandidate(env.EBUY_DB, runId, candidate.request_id, error)
    return { requestId: candidate.request_id, candidateError: { code: error.code || 'ebuy_candidate_failed', message: error.message } }
  }
}

async function processCandidateBatch(env, runId, limit = 4) {
  const candidates = await nextEbuySyncCandidateBatch(env.EBUY_DB, runId, limit)
  if (!candidates.length) return { complete: true, processed: 0 }
  const totals = { processed: 0, inserted: 0, updated: 0, unchanged: 0, removed: 0, archivedFiles: 0, candidateErrors: [], candidateWarnings: [], attachmentFailures: [] }
  return withContractToken(env, candidates[0].contract_number, async (jwt) => {
    for (const candidate of candidates) {
      const result = await processCandidateWithToken(env, runId, candidate, jwt)
      totals.processed++
      mergeCounts(totals, { ...result, discovered: 0 })
      if (result.candidateError) totals.candidateErrors.push({ requestId: result.requestId, ...result.candidateError })
      if (result.candidateWarning) totals.candidateWarnings.push(result.candidateWarning)
      if (result.attachmentFailures?.length) totals.attachmentFailures.push(...result.attachmentFailures.map((item) => ({ requestId: result.requestId, ...item })))
    }
    return totals
  })
}

export async function runEbuySyncWorkflow(env, event, step) {
  if (!env.EBUY_DB) throw new Error('The EBUY_DB binding is unavailable')
  const mode = event.payload?.mode || 'live'
  const run = await step.do('Create eBuy sync record', () => startEbuySyncRun(env.EBUY_DB, mode, {
    instanceId: event.instanceId,
    source: event.payload?.source || 'manual',
    progress: { phase: 'preparing', percent: 2, message: 'Preparing eBuy synchronization' },
  }))
  const totals = { discovered: 0, inserted: 0, updated: 0, unchanged: 0, removed: 0, archivedFiles: 0, candidateErrors: [], candidateWarnings: [], attachmentFailures: [] }
  let processedCandidates = 0
  let totalCandidates = 0

  try {
    if (mode === 'live') {
      await step.do('Remove legacy eBuy demo records', () => deleteEbuyFixtureRecords(env.EBUY_DB))
      await step.do('Record eBuy authentication progress', () => updateEbuySyncRunProgress(env.EBUY_DB, run.id, totals, {
        phase: 'authenticating', percent: 5, message: 'Connecting securely to GSA eBuy',
      }))
      const connection = await step.do('Authenticate company eBuy connection', {
        retries: { limit: 1, delay: '20 seconds', backoff: 'constant' }, timeout: '1 minute',
      }, async () => {
        const session = await getEbuyLiveSession(env)
        return { contracts: session.contracts }
      })
      const contractTotal = connection.contracts.length
      await step.do('Record eBuy discovery start', () => updateEbuySyncRunProgress(env.EBUY_DB, run.id, totals, {
        phase: 'discovering', percent: 10, message: `Checking ${contractTotal} seller contract${contractTotal === 1 ? '' : 's'}`,
        contractsCompleted: 0, contractTotal,
      }))
      for (const [contractIndex, contract] of connection.contracts.entries()) {
        const discovery = await step.do(`Load ${contract.contractNumber} opportunities`, {
          retries: { limit: 2, delay: '20 seconds', backoff: 'exponential' }, timeout: '2 minutes',
        }, () => discoverContract(env, run.id, contract.contractNumber))
        totals.discovered += Number(discovery.discovered || 0)
        mergeCounts(totals, { ...(discovery.summarySync || {}), discovered: 0 })
        const contractsCompleted = contractIndex + 1
        const discoveryPercent = 10 + Math.round((contractsCompleted / Math.max(1, contractTotal)) * 20)
        await step.do(`Record eBuy discovery progress ${contractsCompleted}`, () => updateEbuySyncRunProgress(env.EBUY_DB, run.id, totals, {
          phase: 'discovering', percent: discoveryPercent,
          message: `Found ${totals.discovered} opportunit${totals.discovered === 1 ? 'y' : 'ies'}`,
          contractsCompleted, contractTotal,
        }))
      }

      let remaining = await step.do('Count eBuy opportunities to process', () => countPendingEbuySyncCandidates(env.EBUY_DB, run.id))
      totalCandidates = remaining
      await step.do('Record eBuy processing start', () => updateEbuySyncRunProgress(env.EBUY_DB, run.id, totals, {
        phase: 'processing', percent: remaining ? 30 : 96,
        message: remaining ? `Processing 0 of ${remaining} opportunities` : 'Finalizing eBuy synchronization',
        processed: 0, total: remaining,
      }))
      let iteration = 0
      while (remaining > 0) {
        iteration++
        const result = await step.do(`Archive eBuy opportunity batch ${iteration}`, {
          retries: { limit: 4, delay: '10 seconds', backoff: 'exponential' }, timeout: '5 minutes',
        }, () => processCandidateBatch(env, run.id, 6))
        if (!result.processed) throw new Error('The eBuy synchronization batch did not advance')
        processedCandidates += result.processed
        mergeCounts(totals, { ...result, discovered: 0 })
        if (result.candidateErrors?.length) totals.candidateErrors.push(...result.candidateErrors)
        if (result.candidateWarnings?.length) totals.candidateWarnings.push(...result.candidateWarnings)
        if (result.attachmentFailures?.length) totals.attachmentFailures.push(...result.attachmentFailures)
        remaining -= result.processed
        const processingPercent = Math.min(95, 30 + Math.round((processedCandidates / Math.max(1, totalCandidates)) * 65))
        await step.do(`Record eBuy processing progress ${iteration}`, () => updateEbuySyncRunProgress(env.EBUY_DB, run.id, totals, {
          phase: 'processing', percent: processingPercent,
          message: `Processed ${processedCandidates} of ${totalCandidates} opportunities`,
          processed: processedCandidates, total: totalCandidates,
          archivedFiles: totals.archivedFiles,
        }))
      }
      await step.do('Record eBuy finalization progress', () => updateEbuySyncRunProgress(env.EBUY_DB, run.id, totals, {
        phase: 'finalizing', percent: 97, message: 'Finalizing eBuy synchronization',
        processed: processedCandidates, total: totalCandidates, archivedFiles: totals.archivedFiles,
      }))
      if (!totals.candidateErrors.length) {
        totals.removed = await step.do('Mark unavailable eBuy opportunities', () => completeLiveEbuySnapshot(env.EBUY_DB, run.startedAt))
      }
      await step.do('Record successful eBuy connection run', () => recordEbuyConnectionResult(env.EBUY_DB, { ok: true, synced: true }))
      await step.do('Clear eBuy sync staging records', () => clearEbuySyncCandidates(env.EBUY_DB, run.id))
    } else {
      throw new Error(`Unsupported eBuy sync mode: ${mode}`)
    }

    totals.details = {
      candidateErrors: totals.candidateErrors.slice(0, 20),
      candidateWarnings: totals.candidateWarnings.slice(0, 20),
      attachmentFailures: totals.attachmentFailures.slice(0, 20),
    }
    const incompleteError = totals.candidateErrors.length
      ? new Error(`${totals.candidateErrors.length} eBuy opportunit${totals.candidateErrors.length === 1 ? 'y' : 'ies'} could not be saved`)
      : null
    totals.details.progress = {
      phase: incompleteError ? 'complete_with_issues' : 'complete', percent: 100,
      message: incompleteError ? incompleteError.message : `Synchronized ${totals.discovered} opportunities`,
      processed: processedCandidates, total: totalCandidates, archivedFiles: totals.archivedFiles,
    }
    await step.do('Complete eBuy sync record', () => finishEbuySyncRun(env.EBUY_DB, run.id, totals, incompleteError))
    return { ok: !incompleteError, runId: run.id, ...totals }
  } catch (error) {
    if (mode === 'live') {
      await step.do('Record eBuy connection failure', () => recordEbuyConnectionResult(env.EBUY_DB, {
        ok: false, code: error.code || 'ebuy_sync_failed', message: error.message, synced: true,
      }))
    }
    totals.details = {
      candidateErrors: totals.candidateErrors.slice(0, 20),
      candidateWarnings: totals.candidateWarnings.slice(0, 20),
      attachmentFailures: totals.attachmentFailures.slice(0, 20),
      progress: {
        phase: 'error', percent: totalCandidates ? Math.min(95, 30 + Math.round((processedCandidates / Math.max(1, totalCandidates)) * 65)) : 5,
        message: error.message, processed: processedCandidates, total: totalCandidates, archivedFiles: totals.archivedFiles,
      },
    }
    await step.do('Record eBuy sync failure', () => finishEbuySyncRun(env.EBUY_DB, run.id, totals, error))
    throw error
  }
}

export class EbuySyncWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    return runEbuySyncWorkflow(this.env, event, step)
  }
}
