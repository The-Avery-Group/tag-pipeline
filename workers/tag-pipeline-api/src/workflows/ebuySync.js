import { WorkflowEntrypoint } from 'cloudflare:workers'
import { EBUY_FIXTURE_OPPORTUNITIES } from '../fixtures/ebuyOpportunities.js'
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
  finishEbuySyncCandidate,
  finishEbuySyncRun,
  getArchivedEbuyAttachmentIds,
  nextEbuySyncCandidate,
  recordArchivedEbuyAttachment,
  recordEbuyAttachmentFailure,
  recordEbuyConnectionResult,
  stageEbuySyncCandidates,
  startEbuySyncRun,
  syncEbuyOpportunities,
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
    return { discovered: records.length, staged }
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

async function processCandidate(env, runId) {
  const candidate = await nextEbuySyncCandidate(env.EBUY_DB, runId)
  if (!candidate) return { complete: true }
  const summary = JSON.parse(candidate.summary_json || '{}')
  try {
    const result = await withContractToken(env, candidate.contract_number, async (jwt) => {
      const detail = await getEbuyOpportunityDetail(candidate.request_id, candidate.contract_number, jwt)
      const record = normalizeLiveEbuyOpportunity(summary, detail, candidate.contract_number)
      const sync = await syncEbuyOpportunities(env.EBUY_DB, [record], { source: 'live', completeSnapshot: false })
      const archive = await archiveAttachments(env, record, jwt)
      return { ...sync, ...archive }
    })
    await finishEbuySyncCandidate(env.EBUY_DB, runId, candidate.request_id)
    return { complete: false, requestId: candidate.request_id, ...result }
  } catch (error) {
    await finishEbuySyncCandidate(env.EBUY_DB, runId, candidate.request_id, error)
    return { complete: false, requestId: candidate.request_id, candidateError: { code: error.code || 'ebuy_candidate_failed', message: error.message } }
  }
}

export async function runEbuySyncWorkflow(env, event, step) {
  if (!env.EBUY_DB) throw new Error('The EBUY_DB binding is unavailable')
  const mode = event.payload?.mode || 'fixture'
  const run = await step.do('Create eBuy sync record', () => startEbuySyncRun(env.EBUY_DB, mode, {
    instanceId: event.instanceId,
    source: event.payload?.source || 'manual',
  }))
  const totals = { discovered: 0, inserted: 0, updated: 0, unchanged: 0, removed: 0, archivedFiles: 0, candidateErrors: [], attachmentFailures: [] }

  try {
    if (mode === 'fixture') {
      const fixtureResult = await step.do('Synchronize eBuy test archive', {
        retries: { limit: 2, delay: '10 seconds', backoff: 'exponential' }, timeout: '2 minutes',
      }, () => syncEbuyOpportunities(env.EBUY_DB, EBUY_FIXTURE_OPPORTUNITIES, { source: 'fixture', completeSnapshot: false }))
      mergeCounts(totals, fixtureResult)
    } else if (mode === 'live') {
      const connection = await step.do('Authenticate company eBuy connection', {
        retries: { limit: 1, delay: '20 seconds', backoff: 'constant' }, timeout: '1 minute',
      }, async () => {
        const session = await getEbuyLiveSession(env)
        return { contracts: session.contracts }
      })
      for (const contract of connection.contracts) {
        const discovery = await step.do(`Load ${contract.contractNumber} opportunities`, {
          retries: { limit: 2, delay: '20 seconds', backoff: 'exponential' }, timeout: '2 minutes',
        }, () => discoverContract(env, run.id, contract.contractNumber))
        totals.discovered += Number(discovery.discovered || 0)
      }

      let remaining = await step.do('Count eBuy opportunities to process', () => countPendingEbuySyncCandidates(env.EBUY_DB, run.id))
      let iteration = 0
      while (remaining > 0) {
        iteration++
        const result = await step.do(`Archive eBuy opportunity ${iteration}`, {
          retries: { limit: 1, delay: '20 seconds', backoff: 'constant' }, timeout: '5 minutes',
        }, () => processCandidate(env, run.id))
        mergeCounts(totals, { ...result, discovered: 0 })
        if (result.candidateError) totals.candidateErrors.push({ requestId: result.requestId, ...result.candidateError })
        if (result.attachmentFailures?.length) totals.attachmentFailures.push(...result.attachmentFailures.map((item) => ({ requestId: result.requestId, ...item })))
        remaining--
      }
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
      attachmentFailures: totals.attachmentFailures.slice(0, 20),
    }
    await step.do('Complete eBuy sync record', () => finishEbuySyncRun(env.EBUY_DB, run.id, totals))
    return { ok: true, runId: run.id, ...totals }
  } catch (error) {
    if (mode === 'live') {
      await step.do('Record eBuy connection failure', () => recordEbuyConnectionResult(env.EBUY_DB, {
        ok: false, code: error.code || 'ebuy_sync_failed', message: error.message, synced: true,
      }))
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
