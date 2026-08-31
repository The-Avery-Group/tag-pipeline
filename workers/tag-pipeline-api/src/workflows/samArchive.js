import { WorkflowEntrypoint } from 'cloudflare:workers'
import {
  ensureSAMArchive,
  getSAMArchive,
  getSAMArchiveFile,
  recordSAMArchiveFile,
  updateSAMArchive,
} from '../lib/samArchiveRepository.js'
import { archiveSAMFile, ensureSAMArchiveFolder } from '../lib/sharepointArchive.js'
import { attachmentRecordId, fetchSAMAttachment, fetchWorkspaceSAMNotice } from '../lib/opportunityWorkspaceSam.js'

export const SAM_ARCHIVE_FILES_PER_CHECKPOINT = 4

function safeInstancePart(value) {
  return String(value || crypto.randomUUID()).replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 70)
}

async function scheduleContinuation(env, step, opportunityKey, cursor) {
  const instanceId = `sam-archive-${safeInstancePart(opportunityKey)}-${cursor}-${crypto.randomUUID().slice(0, 8)}`
  const instances = await step.do(`Schedule SAM.gov archive checkpoint ${cursor}`, () => (
    env.SAM_ARCHIVE_WORKFLOW.createBatch([{
      id: instanceId,
      params: { opportunityKey, cursor, continuation: true },
      retention: { successRetention: '3 days', errorRetention: '7 days' },
    }])
  ))
  return { instanceId: instances[0]?.id || instanceId, started: Boolean(instances[0]) }
}

export async function runSAMArchiveWorkflow(env, event, step) {
  const opportunityKey = String(event.payload?.opportunityKey || '').trim().toLowerCase()
  const startCursor = Math.max(0, Number(event.payload?.cursor) || 0)
  if (!env.EBUY_DB || !opportunityKey) return { ok: false, error: 'SAM.gov archive metadata is unavailable' }

  try {
    if (event.payload?.archiveInput) {
      await step.do('Create SAM.gov archive request', () => ensureSAMArchive(env.EBUY_DB, {
        ...event.payload.archiveInput,
        opportunityKey,
      }, { automatic: true }))
    }
    let archive = await step.do('Load SAM.gov archive request', () => getSAMArchive(env.EBUY_DB, opportunityKey))
    if (!archive) return { ok: false, error: 'SAM.gov archive request was not found' }

    const notice = await step.do('Load current SAM.gov attachment list', {
      retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' },
      timeout: '1 minute',
    }, () => fetchWorkspaceSAMNotice(env, {
      noticeId: archive.noticeId,
      solicitationNumber: archive.solicitationNumber,
    }))

    archive = await step.do('Update SAM.gov attachment total', () => ensureSAMArchive(env.EBUY_DB, {
      opportunityKey,
      noticeId: notice.noticeId || archive.noticeId,
      solicitationNumber: archive.solicitationNumber,
      title: archive.title,
      department: archive.department,
      agency: archive.agency,
      attachmentTotal: notice.resourceLinks.length,
    }))

    if (!notice.resourceLinks.length) {
      await step.do('Complete empty SAM.gov archive', () => updateSAMArchive(env.EBUY_DB, opportunityKey, {
        archiveStatus: 'ready', progressPhase: 'No SAM.gov attachments found',
        attachmentTotal: 0, archivedCount: 0, failedCount: 0, errorMessage: null,
        completedAt: new Date().toISOString(),
      }))
      return { ok: true, status: 'ready', attachmentTotal: 0 }
    }

    const location = await step.do('Prepare SAM.gov SharePoint archive folder', {
      retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' }, timeout: '2 minutes',
    }, () => ensureSAMArchiveFolder(env, opportunityKey, { fastLookup: Boolean(archive.folderId) }))
    await step.do('Record SAM.gov archive folder', () => updateSAMArchive(env.EBUY_DB, opportunityKey, {
      driveId: location.driveId, folderId: location.folderId, webUrl: location.webUrl,
      archiveStatus: 'running', progressPhase: `Archiving ${Math.min(startCursor, notice.resourceLinks.length)} of ${notice.resourceLinks.length} files`,
    }))

    const endCursor = Math.min(notice.resourceLinks.length, startCursor + SAM_ARCHIVE_FILES_PER_CHECKPOINT)
    for (let index = startCursor; index < endCursor; index += 1) {
      const sourceUrl = notice.resourceLinks[index]
      const id = await attachmentRecordId(opportunityKey, sourceUrl)
      await step.do(`Archive SAM.gov file ${index + 1}`, {
        retries: { limit: 2, delay: '10 seconds', backoff: 'exponential' }, timeout: '5 minutes',
      }, async () => {
        const prior = await getSAMArchiveFile(env.EBUY_DB, opportunityKey, sourceUrl)
        if (['archived', 'moved'].includes(prior?.archive_status) && prior?.sharepoint_item_id) return
        try {
          const attachment = await fetchSAMAttachment(env, sourceUrl, index)
          const uploaded = await archiveSAMFile(env, {
            opportunityKey,
            fileName: attachment.fileName,
            contentType: attachment.contentType,
            body: attachment.response.body,
            archiveLocation: location,
          })
          await recordSAMArchiveFile(env.EBUY_DB, {
            id, opportunityKey, sourceUrl,
            fileName: uploaded.name || attachment.fileName,
            contentType: attachment.contentType,
            byteSize: uploaded.size || attachment.byteSize,
            sourceSignature: attachment.sourceSignature,
            archiveStatus: 'archived',
            driveId: uploaded.driveId,
            itemId: uploaded.itemId,
            webUrl: uploaded.webUrl,
            archivedAt: new Date().toISOString(),
          })
        } catch (error) {
          await recordSAMArchiveFile(env.EBUY_DB, {
            id, opportunityKey, sourceUrl, fileName: `SAM attachment ${index + 1}`,
            archiveStatus: 'failed', errorMessage: error.message,
          })
        }
      })

      const current = await step.do(`Count SAM.gov archive progress ${index + 1}`, () => getSAMArchive(env.EBUY_DB, opportunityKey))
      const archivedCount = current.files.filter((file) => ['archived', 'moved'].includes(file.archiveStatus)).length
      const failedCount = current.files.filter((file) => file.archiveStatus === 'failed').length
      await step.do(`Record SAM.gov archive progress ${index + 1}`, () => updateSAMArchive(env.EBUY_DB, opportunityKey, {
        archivedCount, failedCount,
        progressPhase: `Processed ${index + 1} of ${notice.resourceLinks.length} files`,
      }))
    }

    if (endCursor < notice.resourceLinks.length) {
      const continuation = await scheduleContinuation(env, step, opportunityKey, endCursor)
      await step.do('Record SAM.gov archive continuation', () => updateSAMArchive(env.EBUY_DB, opportunityKey, {
        archiveStatus: 'running', workflowInstanceId: continuation.instanceId,
        progressPhase: `Processed ${endCursor} of ${notice.resourceLinks.length} files · continuing automatically`,
      }))
      return { ok: true, status: 'continuing', processed: endCursor, attachmentTotal: notice.resourceLinks.length }
    }

    const completed = await step.do('Read completed SAM.gov archive', () => getSAMArchive(env.EBUY_DB, opportunityKey))
    const archivedCount = completed.files.filter((file) => ['archived', 'moved'].includes(file.archiveStatus)).length
    const failedCount = completed.files.filter((file) => file.archiveStatus === 'failed').length
    await step.do('Complete SAM.gov archive', () => updateSAMArchive(env.EBUY_DB, opportunityKey, {
      archiveStatus: failedCount ? 'partial' : 'ready',
      progressPhase: failedCount ? `${failedCount} attachment${failedCount === 1 ? '' : 's'} need attention` : 'SAM.gov archive ready',
      archivedCount, failedCount,
      errorMessage: failedCount ? `${failedCount} SAM.gov attachment${failedCount === 1 ? '' : 's'} could not be archived` : null,
      completedAt: new Date().toISOString(),
    }))
    return { ok: true, status: failedCount ? 'partial' : 'ready', archivedCount, failedCount }
  } catch (error) {
    await step.do('Record SAM.gov archive failure', () => updateSAMArchive(env.EBUY_DB, opportunityKey, {
      archiveStatus: 'error', progressPhase: 'SAM.gov archive needs attention',
      errorMessage: error.message, completedAt: new Date().toISOString(),
    })).catch(() => {})
    console.warn(JSON.stringify({ event: 'sam_archive_failed', opportunityKey, message: error.message }))
    return { ok: false, error: error.message }
  }
}

export class SAMArchiveWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    return runSAMArchiveWorkflow(this.env, event, step)
  }
}
