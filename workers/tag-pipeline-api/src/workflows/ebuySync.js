import { WorkflowEntrypoint } from 'cloudflare:workers'
import {
  downloadEbuyAttachment,
  getEbuyContractToken,
  getEbuyOpportunityDetail,
  listActiveEbuyOpportunities,
  normalizeLiveEbuyOpportunity,
} from '../lib/ebuyClient.js'
import { getEbuyLiveSession } from '../lib/ebuyConnection.js'
import { decryptEbuySecret, encryptEbuySecret } from '../lib/ebuyCrypto.js'
import {
  clearEbuySyncCandidates,
  completeLiveEbuySnapshot,
  countPendingEbuyAttachments,
  countPendingEbuySyncCandidates,
  deleteEbuyFixtureRecords,
  finishEbuySyncCandidate,
  finishEbuySyncRun,
  getEbuyAttachmentArchiveProgress,
  nextPendingEbuyAttachment,
  nextEbuySyncCandidateBatch,
  recordArchivedEbuyAttachment,
  recordEbuyAttachmentFailure,
  recordEbuyConnectionResult,
  resetRetryableEbuyAttachments,
  resumeEbuySyncRun,
  stageEbuySyncCandidates,
  startEbuySyncRun,
  syncEbuyOpportunities,
  updateEbuyAttachmentLocation,
  updateEbuySyncRunProgress,
} from '../lib/ebuyRepository.js'
import { getWorkspace } from '../lib/opportunityWorkspaceRepository.js'
import { archiveEbuyFile, deleteEmptyEbuyArchiveFolder, ensureEbuyArchiveFolder, moveArchivedEbuyFile } from '../lib/sharepointArchive.js'
import { EBUY_ARCHIVE_FILES_PER_CHECKPOINT, scheduleEbuyArchiveContinuation } from './ebuySyncChain.js'
import { refreshEbuyFollowOnWatches } from '../handlers/rfiFollowUpMonitor.js'

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

async function encryptedContractTokens(env, contracts) {
  const session = await getEbuyLiveSession(env)
  const tokens = {}
  for (const contract of contracts) {
    const contractNumber = String(contract?.contractNumber || contract || '').trim()
    if (!contractNumber) continue
    const token = await getEbuyContractToken(session.accessToken, contractNumber)
    tokens[contractNumber] = await encryptEbuySecret(env.EBUY_CREDENTIAL_ENCRYPTION_KEY, { token })
  }
  return tokens
}

async function contractToken(env, encryptedTokens, contractNumber) {
  const envelope = encryptedTokens?.[contractNumber]
  if (!envelope) {
    const error = new Error(`The authenticated eBuy contract ${contractNumber || 'for this opportunity'} is unavailable`)
    error.code = 'ebuy_contract_token_missing'
    throw error
  }
  const decrypted = await decryptEbuySecret(env.EBUY_CREDENTIAL_ENCRYPTION_KEY, envelope)
  if (!decrypted?.token) throw new Error('The secured eBuy contract session is invalid')
  return decrypted.token
}

async function downloadPendingAttachment(env, encryptedTokens, pending) {
  const jwt = await contractToken(env, encryptedTokens, pending.contractNumber)
  try {
    return await downloadEbuyAttachment(pending.requestId, pending.attachment, jwt)
  } catch (error) {
    if (error?.code !== 'ebuy_authentication_failed') throw error

    // A long archive run can outlive a contract JWT. Refresh it once inside
    // the current durable file step before treating the connection as broken.
    const session = await getEbuyLiveSession(env, { force: true })
    const refreshedJwt = await getEbuyContractToken(session.accessToken, pending.contractNumber)
    encryptedTokens[pending.contractNumber] = await encryptEbuySecret(
      env.EBUY_CREDENTIAL_ENCRYPTION_KEY,
      { token: refreshedJwt },
    )
    return downloadEbuyAttachment(pending.requestId, pending.attachment, refreshedJwt)
  }
}

function isAttachmentConnectionFailure(error) {
  return new Set([
    'ebuy_authentication_failed',
    'ebuy_network_error',
    'ebuy_timeout',
    'ebuy_contract_token_missing',
  ]).has(error?.code)
}

async function archiveNextAttachment(env, runStartedAt, encryptedTokens) {
  const pending = await nextPendingEbuyAttachment(env.EBUY_DB, runStartedAt)
  if (!pending) return { processed: 0, archivedFiles: 0 }
  try {
    const downloaded = await downloadPendingAttachment(env, encryptedTokens, pending)
    const contentType = downloaded.headers.get('Content-Type') || pending.attachment.contentType || 'application/octet-stream'
    const archiveLocation = await ensureEbuyArchiveFolder(env, pending.requestId, {
      fastLookup: pending.archiveFolderReady,
    })
    const archived = await archiveEbuyFile(env, {
      requestId: pending.requestId,
      fileName: pending.attachment.fileName,
      contentType,
      body: downloaded.body,
      archiveLocation,
    })
    await recordArchivedEbuyAttachment(env.EBUY_DB, {
      id: pending.id,
      requestId: pending.requestId,
      fileName: pending.attachment.fileName,
      contentType,
      byteSize: archived.size || Number(downloaded.headers.get('Content-Length') || 0),
      sourceHash: null,
      driveId: archived.driveId,
      itemId: archived.itemId,
      webUrl: archived.webUrl,
    })
    let finalLocation = archived
    if (pending.pipelineContractId) {
      const workspace = await getWorkspace(env.EBUY_DB, pending.pipelineContractId)
      if (workspace?.sharePointDriveId && workspace?.samFolderId) {
        finalLocation = await moveArchivedEbuyFile(env, {
          sourceDriveId: archived.driveId,
          itemId: archived.itemId,
          targetDriveId: workspace.sharePointDriveId,
          targetFolderId: workspace.samFolderId,
          fileName: pending.attachment.fileName,
        })
        await updateEbuyAttachmentLocation(env.EBUY_DB, pending.id, finalLocation)
        try {
          await deleteEmptyEbuyArchiveFolder(env, archived.driveId, pending.requestId)
        } catch (cleanupError) {
          console.warn(JSON.stringify({
            event: 'ebuy_attachment_archive_cleanup_deferred',
            requestId: pending.requestId,
            message: cleanupError.message,
          }))
        }
      }
    }
    return { processed: 1, archivedFiles: 1, requestId: pending.requestId, attachmentId: pending.id, workspaceFile: finalLocation.webUrl }
  } catch (error) {
    // Authentication and transport failures affect the connection rather than
    // this individual file. Stop the run and leave this and later files pending
    // so the next sync can resume without creating dozens of false file errors.
    if (isAttachmentConnectionFailure(error)) throw error
    await recordEbuyAttachmentFailure(env.EBUY_DB, pending.id, error.message)
    return {
      processed: 1,
      archivedFiles: 0,
      requestId: pending.requestId,
      attachmentFailure: { requestId: pending.requestId, attachmentId: pending.id, message: error.message },
    }
  }
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
    let record = normalizeLiveEbuyOpportunity(summary, detail, candidate.contract_number)
    const attachmentEvidenceIncomplete = record.attachmentReferences?.mentioned && !record.attachments.length
      || record.attachmentReferences?.missing?.length > 0
    if (!candidateWarning && attachmentEvidenceIncomplete) {
      try {
        const verifiedDetail = await getEbuyOpportunityDetail(candidate.request_id, candidate.contract_number, jwt)
        record = normalizeLiveEbuyOpportunity(summary, verifiedDetail, candidate.contract_number)
      } catch (error) {
        candidateWarning = {
          requestId: candidate.request_id,
          code: error.code || 'ebuy_attachment_verification_failed',
          message: `${error.message}; attachment references will be checked again on the next sync`,
        }
      }
    }
    if (!candidateWarning && (record.attachmentReferences?.mentioned && !record.attachments.length || record.attachmentReferences?.missing?.length > 0)) {
      candidateWarning = {
        requestId: candidate.request_id,
        code: 'ebuy_attachment_reference_unresolved',
        message: 'The description references files that GSA eBuy did not include in its attachment data; they will be checked again on the next sync',
      }
    }
    if (candidateWarning) record.sourceDetails.detailStatus = candidateWarning.code || 'detail_warning'
    const sync = await syncEbuyOpportunities(env.EBUY_DB, [record], { source: 'live', completeSnapshot: false })
    await finishEbuySyncCandidate(env.EBUY_DB, runId, candidate.request_id)
    return { requestId: candidate.request_id, ...sync, candidateWarning }
  } catch (error) {
    if (error?.code === 'ebuy_authentication_failed') throw error
    await finishEbuySyncCandidate(env.EBUY_DB, runId, candidate.request_id, error)
    return { requestId: candidate.request_id, candidateError: { code: error.code || 'ebuy_candidate_failed', message: error.message } }
  }
}

async function processCandidateBatch(env, runId, encryptedTokens, limit = 1) {
  const candidates = await nextEbuySyncCandidateBatch(env.EBUY_DB, runId, limit)
  if (!candidates.length) return { complete: true, processed: 0 }
  const totals = { processed: 0, inserted: 0, updated: 0, unchanged: 0, removed: 0, archivedFiles: 0, candidateErrors: [], candidateWarnings: [], attachmentFailures: [] }
  const jwt = await contractToken(env, encryptedTokens, candidates[0].contract_number)
  for (const candidate of candidates) {
    const result = await processCandidateWithToken(env, runId, candidate, jwt)
    totals.processed++
    mergeCounts(totals, { ...result, discovered: 0 })
    if (result.candidateError) totals.candidateErrors.push({ requestId: result.requestId, ...result.candidateError })
    if (result.candidateWarning) totals.candidateWarnings.push(result.candidateWarning)
  }
  return totals
}

export async function runEbuySyncWorkflow(env, event, step) {
  if (!env.EBUY_DB) throw new Error('The EBUY_DB binding is unavailable')
  const mode = event.payload?.mode || 'live'
  const resumeRunId = String(event.payload?.resumeRunId || '').trim()
  const archiveCheckpoint = Math.max(1, Number(event.payload?.archiveCheckpoint) || 1)
  const continuationKey = String(event.payload?.continuationKey || event.instanceId || resumeRunId || '').trim()
  const source = event.payload?.source || 'manual'
  const run = resumeRunId
    ? await step.do('Resume interrupted eBuy sync record', () => resumeEbuySyncRun(env.EBUY_DB, resumeRunId))
    : await step.do('Create eBuy sync record', () => startEbuySyncRun(env.EBUY_DB, mode, {
      instanceId: event.instanceId,
      source: event.payload?.source || 'manual',
      progress: { phase: 'preparing', percent: 2, message: 'Preparing eBuy synchronization' },
    }))
  const totals = { discovered: 0, inserted: 0, updated: 0, unchanged: 0, removed: 0, archivedFiles: 0, candidateErrors: [], candidateWarnings: [], attachmentFailures: [] }
  totals.discovered = Number(run.discovered || 0)
  let processedCandidates = Number(run.processedCandidates || 0)
  let totalCandidates = Number(run.totalCandidates || 0)
  let processedAttachments = 0
  let totalAttachments = 0

  try {
    if (mode === 'live') {
      if (!resumeRunId) await step.do('Remove legacy eBuy demo records', () => deleteEbuyFixtureRecords(env.EBUY_DB))
      await step.do('Record eBuy authentication progress', () => updateEbuySyncRunProgress(env.EBUY_DB, run.id, totals, {
        phase: resumeRunId ? 'resuming' : 'authenticating', percent: resumeRunId ? 28 : 5,
        message: resumeRunId ? 'Reconnecting to continue the interrupted synchronization' : 'Connecting securely to GSA eBuy',
      }))
      const connection = await step.do('Authenticate company eBuy connection', {
        retries: { limit: 1, delay: '20 seconds', backoff: 'constant' }, timeout: '1 minute',
      }, async () => {
        const session = await getEbuyLiveSession(env)
        return { contracts: session.contracts }
      })
      await step.do('Record active eBuy connection', () => recordEbuyConnectionResult(env.EBUY_DB, { ok: true }))
      if (!resumeRunId) {
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
      }

      let remaining = await step.do('Count eBuy opportunities to process', () => countPendingEbuySyncCandidates(env.EBUY_DB, run.id))
      if (!totalCandidates) totalCandidates = processedCandidates + remaining
      const securedTokens = await step.do('Secure eBuy contract sessions for processing', {
        retries: { limit: 3, delay: '20 seconds', backoff: 'exponential' }, timeout: '2 minutes',
      }, () => encryptedContractTokens(env, connection.contracts))
      await step.do('Record eBuy processing start', () => updateEbuySyncRunProgress(env.EBUY_DB, run.id, totals, {
        phase: 'processing', percent: remaining ? 30 + Math.round((processedCandidates / Math.max(1, totalCandidates)) * 40) : 70,
        message: remaining ? `Processing ${processedCandidates} of ${totalCandidates} opportunities` : 'Opportunity details are up to date',
        processed: processedCandidates, total: totalCandidates,
      }))
      let iteration = 0
      while (remaining > 0) {
        iteration++
        const result = await step.do(`Process eBuy opportunity ${iteration}`, {
          retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' }, timeout: '3 minutes',
        }, () => processCandidateBatch(env, run.id, securedTokens, 1))
        if (!result.processed) throw new Error('The eBuy synchronization batch did not advance')
        processedCandidates += result.processed
        mergeCounts(totals, { ...result, discovered: 0 })
        if (result.candidateErrors?.length) totals.candidateErrors.push(...result.candidateErrors)
        if (result.candidateWarnings?.length) totals.candidateWarnings.push(...result.candidateWarnings)
        remaining = await step.do(`Count remaining eBuy opportunities ${iteration}`, () => countPendingEbuySyncCandidates(env.EBUY_DB, run.id))
        const processingPercent = Math.min(70, 30 + Math.round((processedCandidates / Math.max(1, totalCandidates)) * 40))
        await step.do(`Record eBuy processing progress ${iteration}`, () => updateEbuySyncRunProgress(env.EBUY_DB, run.id, totals, {
          phase: 'processing', percent: processingPercent,
          message: `Processed ${processedCandidates} of ${totalCandidates} opportunities`,
          processed: processedCandidates, total: totalCandidates,
          archivedFiles: totals.archivedFiles,
        }))
        if (remaining > 0 && iteration % 5 === 0) await step.sleep(`Pace eBuy detail requests ${iteration}`, '1 second')
      }

      await step.do('Prepare failed eBuy files for retry', () => resetRetryableEbuyAttachments(env.EBUY_DB, run.startedAt))
      const archiveProgress = await step.do('Count eBuy files to archive', () => getEbuyAttachmentArchiveProgress(env.EBUY_DB, run.startedAt))
      let remainingAttachments = archiveProgress.pending
      totalAttachments = archiveProgress.total
      processedAttachments = archiveProgress.archived
      totals.archivedFiles = archiveProgress.archived
      await step.do('Record eBuy file archive start', () => updateEbuySyncRunProgress(env.EBUY_DB, run.id, totals, {
        phase: 'archiving', percent: remainingAttachments ? Math.min(95, 72 + Math.round((processedAttachments / Math.max(1, totalAttachments)) * 23)) : 95,
        message: remainingAttachments ? `Archiving ${processedAttachments} of ${totalAttachments} files` : 'No files are waiting to be archived',
        processed: processedCandidates, total: totalCandidates,
        filesProcessed: processedAttachments, filesTotal: totalAttachments, archivedFiles: totals.archivedFiles,
      }))
      let fileIteration = 0
      while (remainingAttachments > 0) {
        fileIteration++
        const result = await step.do(`Archive eBuy file ${fileIteration}`, {
          retries: { limit: 1, delay: '10 seconds', backoff: 'constant' }, timeout: '5 minutes',
        }, () => archiveNextAttachment(env, run.startedAt, securedTokens))
        if (!result.processed) throw new Error('The eBuy file archive did not advance')
        processedAttachments += result.processed
        totals.archivedFiles += Number(result.archivedFiles || 0)
        if (result.attachmentFailure) totals.attachmentFailures.push(result.attachmentFailure)
        remainingAttachments = await step.do(`Count remaining eBuy files ${fileIteration}`, () => countPendingEbuyAttachments(env.EBUY_DB, run.startedAt))
        const filePercent = Math.min(95, 72 + Math.round((processedAttachments / Math.max(1, totalAttachments)) * 23))
        await step.do(`Record eBuy file progress ${fileIteration}`, () => updateEbuySyncRunProgress(env.EBUY_DB, run.id, totals, {
          phase: 'archiving', percent: filePercent,
          message: `Processed ${processedAttachments} of ${totalAttachments} files · ${totals.archivedFiles} archived`,
          processed: processedCandidates, total: totalCandidates,
          filesProcessed: processedAttachments, filesTotal: totalAttachments, archivedFiles: totals.archivedFiles,
        }))

        if (remainingAttachments > 0 && fileIteration >= EBUY_ARCHIVE_FILES_PER_CHECKPOINT) {
          const message = `Archived ${totals.archivedFiles} of ${totalAttachments} files · continuing automatically`
          await step.do('Record eBuy archive continuation', () => updateEbuySyncRunProgress(env.EBUY_DB, run.id, totals, {
            phase: 'archiving', percent: filePercent, message,
            processed: processedCandidates, total: totalCandidates,
            filesProcessed: processedAttachments, filesTotal: totalAttachments, archivedFiles: totals.archivedFiles,
          }))
          const continuation = await scheduleEbuyArchiveContinuation({
            env,
            step,
            runId: run.id,
            continuationKey,
            checkpoint: archiveCheckpoint,
            source,
          })
          console.log(JSON.stringify({
            event: 'ebuy_sync_workflow', status: 'continuing', runId: run.id,
            archiveCheckpoint, nextCheckpoint: continuation.checkpoint,
            nextInstanceId: continuation.instanceId,
            archivedFiles: totals.archivedFiles, filesTotal: totalAttachments,
          }))
          return {
            ok: true,
            status: 'continuing',
            runId: run.id,
            archiveCheckpoint,
            nextCheckpoint: continuation.checkpoint,
            nextInstanceId: continuation.instanceId,
            archivedFiles: totals.archivedFiles,
            filesProcessed: processedAttachments,
            filesTotal: totalAttachments,
          }
        }
      }
      await step.do('Record eBuy finalization progress', () => updateEbuySyncRunProgress(env.EBUY_DB, run.id, totals, {
        phase: 'finalizing', percent: 97, message: 'Finalizing eBuy synchronization',
        processed: processedCandidates, total: totalCandidates,
        filesProcessed: processedAttachments, filesTotal: totalAttachments, archivedFiles: totals.archivedFiles,
      }))
      if (!totals.candidateErrors.length) {
        totals.removed = await step.do('Mark unavailable eBuy opportunities', () => completeLiveEbuySnapshot(env.EBUY_DB, run.startedAt))
      }
    } else {
      throw new Error(`Unsupported eBuy sync mode: ${mode}`)
    }

    totals.details = {
      candidateErrors: totals.candidateErrors.slice(0, 20),
      candidateWarnings: totals.candidateWarnings.slice(0, 20),
      attachmentFailures: totals.attachmentFailures.slice(0, 20),
    }
    const issueParts = []
    if (totals.candidateErrors.length) issueParts.push(`${totals.candidateErrors.length} opportunit${totals.candidateErrors.length === 1 ? 'y' : 'ies'} could not be saved`)
    if (totals.attachmentFailures.length) issueParts.push(`${totals.attachmentFailures.length} file${totals.attachmentFailures.length === 1 ? '' : 's'} could not be archived`)
    const incompleteError = issueParts.length ? new Error(issueParts.join(' · ')) : null
    totals.details.progress = {
      phase: incompleteError ? 'complete_with_issues' : 'complete', percent: 100,
      message: incompleteError ? incompleteError.message : `Synchronized ${totals.discovered} opportunities`,
      processed: processedCandidates, total: totalCandidates,
      filesProcessed: processedAttachments, filesTotal: totalAttachments, archivedFiles: totals.archivedFiles,
    }
    if (incompleteError) {
      await step.do('Record eBuy synchronization issues', () => recordEbuyConnectionResult(env.EBUY_DB, {
        ok: false, code: 'ebuy_sync_incomplete', message: incompleteError.message, synced: true,
      }))
    } else {
      await step.do('Record successful eBuy connection run', () => recordEbuyConnectionResult(env.EBUY_DB, { ok: true, synced: true }))
      await step.do('Refresh eBuy follow-on evidence', () => refreshEbuyFollowOnWatches(env))
      await step.do('Clear eBuy sync staging records', () => clearEbuySyncCandidates(env.EBUY_DB, run.id))
    }
    await step.do('Complete eBuy sync record', () => finishEbuySyncRun(env.EBUY_DB, run.id, totals, incompleteError))
    return { ok: !incompleteError, runId: run.id, ...totals }
  } catch (error) {
    const transientArchiveFailure = mode === 'live' && ['ebuy_network_error', 'ebuy_timeout'].includes(error?.code)
    if (transientArchiveFailure && archiveCheckpoint < 8) {
      const progress = {
        phase: 'reconnecting',
        percent: totalAttachments ? Math.min(95, 72 + Math.round((processedAttachments / Math.max(1, totalAttachments)) * 23)) : 70,
        message: 'GSA eBuy paused unexpectedly · reconnecting automatically',
        processed: processedCandidates,
        total: totalCandidates,
        filesProcessed: processedAttachments,
        filesTotal: totalAttachments,
        archivedFiles: totals.archivedFiles,
      }
      await step.do('Record automatic eBuy recovery', () => updateEbuySyncRunProgress(env.EBUY_DB, run.id, totals, progress))
      await step.sleep(`Wait before eBuy recovery ${archiveCheckpoint}`, `${Math.min(120, 15 * archiveCheckpoint)} seconds`)
      const continuation = await scheduleEbuyArchiveContinuation({
        env,
        step,
        runId: run.id,
        continuationKey,
        checkpoint: archiveCheckpoint,
        source: 'automatic-recovery',
      })
      return { ok: true, status: 'continuing', recovery: true, runId: run.id, ...continuation }
    }
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
        message: error.message, processed: processedCandidates, total: totalCandidates,
        filesProcessed: processedAttachments, filesTotal: totalAttachments, archivedFiles: totals.archivedFiles,
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
