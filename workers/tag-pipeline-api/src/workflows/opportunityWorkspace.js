import { WorkflowEntrypoint } from 'cloudflare:workers'
import { opportunityWorkspaceFolderName } from '../lib/opportunityWorkspaceDomain.js'
import {
  getWorkspace,
  getWorkspaceFile,
  listWorkspaceFileRecords,
  recordWorkspaceFile,
  updateWorkspace,
} from '../lib/opportunityWorkspaceRepository.js'
import {
  getEbuyWorkspaceArchive,
  updateEbuyAttachmentLocation,
} from '../lib/ebuyRepository.js'
import { alertFingerprint, alertStorageReady, upsertOpportunityAlert } from '../lib/opportunityAlerts.js'
import {
  beginWorkspaceTemplateCopy,
  findCopiedWorkspaceFolder,
  finishRecordedWorkspaceFolders,
  finishWorkspaceFolders,
  resolveWorkspaceDestination,
  updatePipelineFolderLink,
  uploadSAMAttachment,
} from '../lib/opportunityWorkspaceSharePoint.js'
import {
  attachmentRecordId,
  attachmentSourceName,
  fetchSAMAttachment,
  fetchWorkspaceSAMNotice,
  portalSourceMetadata,
  portalSourceScope,
  stablePortalSourceSignature,
} from '../lib/opportunityWorkspaceSam.js'
import {
  deleteEmptyEbuyArchiveFolder,
  deleteEmptySAMArchiveFolder,
  moveArchivedEbuyFile,
  moveArchivedSAMFile,
} from '../lib/sharepointArchive.js'
import {
  findSAMArchive,
  updateSAMArchive,
  updateSAMArchiveFileLocation,
} from '../lib/samArchiveRepository.js'

const COPY_POLL_LIMIT = 30

export async function runOpportunityWorkspaceWorkflow(env, event, step) {
  const opportunityKey = event.payload?.opportunityKey
  const syncAttachments = event.payload?.syncAttachments === true
  const sourceRevision = String(event.payload?.sourceRevision || '')
  if (!env.EBUY_DB || !opportunityKey) return { ok: false, error: 'Opportunity workspace metadata is unavailable' }

  try {
    const workspace = await step.do('Load opportunity workspace', () => getWorkspace(env.EBUY_DB, opportunityKey))
    if (!workspace) return { ok: false, error: 'Opportunity workspace request was not found' }
    const folderName = opportunityWorkspaceFolderName({ agency: workspace.agency, title: workspace.title })

    await step.do('Mark workspace provisioning active', () => updateWorkspace(env.EBUY_DB, opportunityKey, {
      status: 'running',
      progressPhase: 'Creating SharePoint workspace',
      workflowInstanceId: event.instanceId,
      errorMessage: null,
    }))

    let folders = await step.do('Check recorded SharePoint workspace', {
      retries: { limit: 2, delay: '5 seconds', backoff: 'exponential' },
      timeout: '1 minute',
    }, () => finishRecordedWorkspaceFolders(env, workspace))

    if (!folders) {
      const destination = await step.do('Resolve SharePoint destination', {
        retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' },
        timeout: '1 minute',
      }, () => resolveWorkspaceDestination(env, workspace, folderName))

      const copy = await step.do('Start SharePoint template copy', {
        retries: { limit: 2, delay: '10 seconds', backoff: 'exponential' },
        timeout: '1 minute',
      }, () => beginWorkspaceTemplateCopy(env, destination))

      if (!copy.completed) {
        for (let attempt = 0; attempt < COPY_POLL_LIMIT; attempt += 1) {
          await step.sleep(`Wait for template copy ${attempt + 1}`, '5 seconds')
          // Graph's copy Location can point at the tenant's SharePoint host.
          // A Microsoft Graph token is not valid for that audience. Check the
          // destination through Graph instead; this is bounded, retryable, and
          // also proves the folder is available before subsequent work starts.
          const result = await step.do(`Check copied destination folder ${attempt + 1}`, {
            retries: { limit: 2, delay: '5 seconds', backoff: 'exponential' },
            timeout: '30 seconds',
          }, () => findCopiedWorkspaceFolder(env, destination))
          if (result.complete) break
          if (attempt === COPY_POLL_LIMIT - 1) throw new Error('SharePoint template copy did not finish in time')
        }
      }

      folders = await step.do('Resolve copied workspace folders', {
        retries: { limit: 4, delay: '5 seconds', backoff: 'exponential' },
        timeout: '1 minute',
      }, () => finishWorkspaceFolders(env, workspace, folderName))
    }

    await step.do('Save SharePoint workspace location', () => updateWorkspace(env.EBUY_DB, opportunityKey, {
      sharePointDriveId: folders.driveId,
      rootFolderId: folders.rootFolderId,
      samFolderId: folders.samFolderId,
      webUrl: folders.webUrl,
      progressPhase: 'Finding SAM.gov attachments',
    }))

    if (!syncAttachments) {
      await step.do('Write workspace link to pipeline', {
        retries: { limit: 4, delay: '5 seconds', backoff: 'exponential' },
        timeout: '2 minutes',
      }, () => updatePipelineFolderLink(env, workspace, folders.webUrl))
    }

    // eBuy files are first preserved in their own archive. Once the user adds
    // that opportunity to the pipeline, move those same DriveItems into the
    // standard opportunity workspace. IDs—not display folder names—join the
    // records, so small naming differences between eBuy and SAM are harmless.
    const ebuyArchive = await step.do('Check for an eBuy opportunity archive', () => (
      getEbuyWorkspaceArchive(env.EBUY_DB, opportunityKey)
    ))
    if (ebuyArchive) {
      const attachments = ebuyArchive.attachments || []
      await step.do('Record eBuy attachment transfer start', () => updateWorkspace(env.EBUY_DB, opportunityKey, {
        attachmentTotal: attachments.length,
        archivedCount: 0,
        failedCount: 0,
        progressPhase: attachments.length ? 'Moving eBuy attachments into the workspace' : 'No eBuy attachments found',
      }))
      let movedCount = 0
      let failedCount = 0
      let sourceDriveId = env.EBUY_ARCHIVE_DRIVE_ID || env.DRIVE_ID || folders.driveId
      for (let index = 0; index < attachments.length; index += 1) {
        const attachment = attachments[index]
        sourceDriveId ||= attachment.sharepoint_drive_id || ''
        try {
          const moved = await step.do(`Move eBuy attachment ${index + 1}`, {
            retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' },
            timeout: '2 minutes',
          }, () => moveArchivedEbuyFile(env, {
            sourceDriveId: attachment.sharepoint_drive_id,
            itemId: attachment.sharepoint_item_id,
            targetDriveId: folders.driveId,
            targetFolderId: folders.samFolderId,
            fileName: attachment.file_name,
          }))
          await step.do(`Record moved eBuy attachment ${index + 1}`, () => updateEbuyAttachmentLocation(
            env.EBUY_DB,
            attachment.id,
            moved,
          ))
          movedCount++
        } catch (error) {
          failedCount++
          console.warn(JSON.stringify({
            event: 'opportunity_workspace_ebuy_attachment_move_failed',
            opportunityKey,
            attachmentId: attachment.id,
            message: error.message,
          }))
        }
        await step.do(`Update eBuy attachment transfer ${index + 1}`, () => updateWorkspace(env.EBUY_DB, opportunityKey, {
          archivedCount: movedCount,
          failedCount,
          progressPhase: `Moved ${movedCount} of ${attachments.length} eBuy attachments`,
        }))
      }

      let archiveRemoved = attachments.length === 0
      if (!failedCount && sourceDriveId) {
        const removal = await step.do('Remove empty eBuy opportunity archive', {
          retries: { limit: 2, delay: '5 seconds', backoff: 'exponential' },
          timeout: '1 minute',
        }, () => deleteEmptyEbuyArchiveFolder(env, sourceDriveId, ebuyArchive.requestId))
        archiveRemoved = removal.deleted
      }
      const completedAt = new Date().toISOString()
      const retainedArchive = !failedCount && !archiveRemoved
      await step.do('Complete eBuy opportunity workspace', () => updateWorkspace(env.EBUY_DB, opportunityKey, {
        status: failedCount || retainedArchive ? 'partial' : 'ready',
        progressPhase: failedCount
          ? `${failedCount} eBuy attachment${failedCount === 1 ? '' : 's'} need attention`
          : retainedArchive
            ? 'Workspace ready; the eBuy archive contains additional files'
            : 'Workspace ready',
        archivedCount: movedCount,
        failedCount,
        errorMessage: failedCount
          ? `${failedCount} eBuy attachment${failedCount === 1 ? '' : 's'} could not be moved`
          : retainedArchive
            ? 'The eBuy archive folder was retained because it is not empty'
            : null,
        completedAt,
      }))
      return {
        ok: true,
        partial: Boolean(failedCount || retainedArchive),
        workspaceUrl: folders.webUrl,
        archivedCount: movedCount,
        failedCount,
        eBuyArchiveRemoved: archiveRemoved,
      }
    }

    // SAM discovery uses the same preservation model as eBuy: files are kept
    // in a source archive before pursuit. Move existing DriveItems into the
    // standard workspace instead of downloading and uploading them again.
    const samArchive = await step.do('Check for a SAM.gov opportunity archive', () => (
      findSAMArchive(env.EBUY_DB, {
        opportunityKey,
        noticeId: workspace.noticeId,
        solicitationNumber: workspace.solicitationNumber,
      })
    ))
    if (samArchive) {
      const archivedFiles = (samArchive.files || []).filter((file) => file.archiveStatus === 'archived' && file.itemId)
      let movedCount = 0
      let moveFailures = 0
      await step.do('Record SAM.gov archive transfer start', () => updateWorkspace(env.EBUY_DB, opportunityKey, {
        attachmentTotal: samArchive.attachmentTotal,
        archivedCount: 0,
        failedCount: 0,
        progressPhase: archivedFiles.length ? 'Moving SAM.gov archive into the workspace' : 'Checking current SAM.gov attachments',
      }))
      for (let index = 0; index < archivedFiles.length; index += 1) {
        const file = archivedFiles[index]
        try {
          const moved = await step.do(`Move SAM.gov archive file ${index + 1}`, {
            retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' }, timeout: '2 minutes',
          }, () => moveArchivedSAMFile(env, {
            sourceDriveId: file.sharePointDriveId,
            itemId: file.itemId,
            targetDriveId: folders.driveId,
            targetFolderId: folders.samFolderId,
            fileName: file.fileName,
          }))
          await step.do(`Record moved SAM.gov archive file ${index + 1}`, async () => {
            await updateSAMArchiveFileLocation(env.EBUY_DB, file.id, moved)
            await recordWorkspaceFile(env.EBUY_DB, {
              id: await attachmentRecordId(opportunityKey, file.sourceUrl),
              opportunityKey,
              sourceNoticeId: samArchive.noticeId,
              sourceUrl: file.sourceUrl,
              fileName: moved.name || file.fileName,
              contentType: file.contentType,
              byteSize: moved.size || file.byteSize,
              sourceSignature: file.sourceSignature,
              archiveStatus: 'archived',
              driveId: moved.driveId,
              itemId: moved.itemId,
              webUrl: moved.webUrl,
              archivedAt: new Date().toISOString(),
            })
          })
          movedCount++
        } catch (error) {
          moveFailures++
          console.warn(JSON.stringify({
            event: 'opportunity_workspace_sam_archive_move_failed', opportunityKey,
            archiveFileId: file.id, message: error.message,
          }))
        }
        await step.do(`Update SAM.gov archive transfer ${index + 1}`, () => updateWorkspace(env.EBUY_DB, opportunityKey, {
          archivedCount: movedCount,
          failedCount: moveFailures,
          progressPhase: `Moved ${movedCount} of ${archivedFiles.length} SAM.gov archive files`,
        }))
      }
      if (!moveFailures && samArchive.sharePointDriveId) {
        const removal = await step.do('Remove empty SAM.gov opportunity archive', {
          retries: { limit: 2, delay: '5 seconds', backoff: 'exponential' }, timeout: '1 minute',
        }, () => deleteEmptySAMArchiveFolder(env, samArchive.sharePointDriveId, samArchive.opportunityKey))
        await step.do('Record SAM.gov archive transfer completion', () => updateSAMArchive(env.EBUY_DB, samArchive.opportunityKey, {
          archiveStatus: removal.deleted ? 'moved' : 'partial',
          progressPhase: removal.deleted ? 'Moved into opportunity workspace' : 'Moved files; archive folder retained',
          archivedCount: movedCount,
          failedCount: moveFailures,
          errorMessage: removal.deleted ? null : 'The SAM.gov archive folder was retained because it is not empty',
          completedAt: new Date().toISOString(),
        }))
      }
    }

    let notice = { noticeId: workspace.noticeId || '', resourceLinks: [] }
    try {
      notice = await step.do('Load current SAM.gov attachment list', {
        retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' },
        timeout: '1 minute',
      }, () => fetchWorkspaceSAMNotice(env, workspace))
    } catch (error) {
      await step.do('Record SAM.gov attachment lookup issue', () => updateWorkspace(env.EBUY_DB, opportunityKey, {
        status: 'partial',
        progressPhase: 'Workspace ready; SAM.gov attachments need attention',
        errorMessage: error.message,
      }))
      return { ok: true, partial: true, workspaceUrl: folders.webUrl, error: error.message }
    }

    await step.do('Record attachment total', () => updateWorkspace(env.EBUY_DB, opportunityKey, {
      attachmentTotal: notice.resourceLinks.length,
      archivedCount: 0,
      failedCount: 0,
      progressPhase: notice.resourceLinks.length ? 'Saving SAM.gov attachments' : 'No SAM.gov attachments found',
    }))

    let archivedCount = 0
    let failedCount = 0
    const changedFiles = []
    const priorRecords = await step.do('Load archived attachment records', () => listWorkspaceFileRecords(env.EBUY_DB, opportunityKey))
    const currentSources = new Set(notice.resourceLinks)
    const unavailablePortalScopes = new Set(notice.resourceLinks
      .filter((sourceUrl) => portalSourceMetadata(sourceUrl)?.issue)
      .map(portalSourceScope))
    const removedFiles = syncAttachments
      ? priorRecords.filter((record) => record.archive_status === 'archived' && !currentSources.has(record.source_url) &&
        !unavailablePortalScopes.has(portalSourceScope(record.source_url)))
      : []
    for (let index = 0; index < notice.resourceLinks.length; index += 1) {
      const sourceUrl = notice.resourceLinks[index]
      const id = await attachmentRecordId(opportunityKey, sourceUrl)
      let result
      try {
        result = await step.do(`Archive SAM attachment ${index + 1}`, {
          retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' },
          timeout: '5 minutes',
        }, async () => {
          const prior = await getWorkspaceFile(env.EBUY_DB, opportunityKey, sourceUrl)
          if (!syncAttachments && prior?.archive_status === 'archived' && prior.sharepoint_item_id) return { ok: true, reused: true }
          const stablePortalSignature = stablePortalSourceSignature(sourceUrl)
          if (stablePortalSignature && prior?.archive_status === 'archived' && prior.sharepoint_item_id && prior.source_signature === stablePortalSignature) {
            return { ok: true, reused: true }
          }
          const attachment = await fetchSAMAttachment(env, sourceUrl, index)
          if (
            prior?.archive_status === 'archived' && prior.sharepoint_item_id &&
            prior.source_signature && attachment.sourceSignature &&
            prior.source_signature === attachment.sourceSignature
          ) {
            if (attachment.response.body) await attachment.response.body.cancel().catch(() => {})
            return { ok: true, reused: true }
          }
          const uploaded = await uploadSAMAttachment(env, {
            driveId: folders.driveId,
            folderId: folders.samFolderId,
            fileName: attachment.fileName,
            contentType: attachment.contentType,
            body: attachment.response.body,
          })
          await recordWorkspaceFile(env.EBUY_DB, {
            id,
            opportunityKey,
            sourceNoticeId: notice.noticeId,
            sourceUrl,
            fileName: uploaded.name || attachment.fileName,
            contentType: attachment.contentType,
            byteSize: uploaded.size || attachment.byteSize,
            sourceSignature: attachment.sourceSignature,
            archiveStatus: 'archived',
            driveId: folders.driveId,
            itemId: uploaded.itemId,
            webUrl: uploaded.webUrl,
            archivedAt: new Date().toISOString(),
          })
          return { ok: true, changed: Boolean(syncAttachments && prior?.archive_status === 'archived'), added: Boolean(syncAttachments && !prior?.sharepoint_item_id), fileName: uploaded.name || attachment.fileName }
        })
      } catch (error) {
        await step.do(`Record failed SAM attachment ${index + 1}`, () => recordWorkspaceFile(env.EBUY_DB, {
            id,
            opportunityKey,
            sourceNoticeId: notice.noticeId,
            sourceUrl,
            fileName: attachmentSourceName(sourceUrl, `SAM attachment ${index + 1}`),
            archiveStatus: 'failed',
            errorMessage: error.message,
          }))
        console.warn(JSON.stringify({
          event: 'opportunity_workspace_attachment_failed',
          opportunityKey,
          attachmentNumber: index + 1,
          message: error.message,
        }))
        result = { ok: false, error: error.message }
      }
      if (result.ok) archivedCount += 1
      else failedCount += 1
      if (result.changed || result.added) changedFiles.push({ name: result.fileName, change: result.added ? 'added' : 'updated' })
      await step.do(`Update attachment progress ${index + 1}`, () => updateWorkspace(env.EBUY_DB, opportunityKey, {
        archivedCount,
        failedCount,
        progressPhase: `Saved ${archivedCount} of ${notice.resourceLinks.length} SAM.gov attachments`,
      }))
    }

    const completedAt = new Date().toISOString()
    await step.do('Complete opportunity workspace', () => updateWorkspace(env.EBUY_DB, opportunityKey, {
      status: failedCount ? 'partial' : 'ready',
      progressPhase: failedCount ? `${failedCount} attachment${failedCount === 1 ? '' : 's'} need attention` : 'Workspace ready',
      archivedCount,
      failedCount,
      errorMessage: failedCount ? `${failedCount} SAM.gov attachment${failedCount === 1 ? '' : 's'} could not be saved` : null,
      completedAt,
    }))
    if (syncAttachments && (changedFiles.length || removedFiles.length)) {
      await step.do('Record SAM attachment alert', async () => {
        if (!(await alertStorageReady(env.EBUY_DB))) return null
        return upsertOpportunityAlert(env.EBUY_DB, {
          opportunityKey,
          type: 'sam_files',
          fingerprint: alertFingerprint({ sourceRevision, current: notice.resourceLinks }),
          summary: `${changedFiles.length + removedFiles.length} SAM.gov attachment change${changedFiles.length + removedFiles.length === 1 ? '' : 's'} found`,
          details: {
            changedFiles,
            removedFiles: removedFiles.map((file) => ({ name: file.file_name, sourceUrl: file.source_url })),
            sourceRevision,
            note: removedFiles.length ? 'Files removed from SAM.gov remain preserved in SharePoint.' : '',
          },
        })
      })
    }
    console.info(JSON.stringify({
      event: 'opportunity_workspace_complete',
      opportunityKey,
      archivedCount,
      failedCount,
      attachmentTotal: notice.resourceLinks.length,
    }))
    return { ok: true, partial: failedCount > 0, workspaceUrl: folders.webUrl, archivedCount, failedCount }
  } catch (error) {
    await step.do('Record opportunity workspace failure', () => updateWorkspace(env.EBUY_DB, opportunityKey, {
      status: 'error',
      progressPhase: 'Workspace setup needs attention',
      errorMessage: error.message,
      completedAt: new Date().toISOString(),
    }))
    console.warn(JSON.stringify({ event: 'opportunity_workspace_failed', opportunityKey, message: error.message }))
    return { ok: false, error: error.message }
  }
}

export class OpportunityWorkspaceWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    return runOpportunityWorkspaceWorkflow(this.env, event, step)
  }
}
