import { WorkflowEntrypoint } from 'cloudflare:workers'
import { opportunityWorkspaceFolderName } from '../lib/opportunityWorkspaceDomain.js'
import {
  getWorkspace,
  getWorkspaceFile,
  recordWorkspaceFile,
  updateWorkspace,
} from '../lib/opportunityWorkspaceRepository.js'
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
  fetchSAMAttachment,
  fetchWorkspaceSAMNotice,
} from '../lib/opportunityWorkspaceSam.js'

const COPY_POLL_LIMIT = 30

export async function runOpportunityWorkspaceWorkflow(env, event, step) {
  const opportunityKey = event.payload?.opportunityKey
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

    await step.do('Write workspace link to pipeline', {
      retries: { limit: 4, delay: '5 seconds', backoff: 'exponential' },
      timeout: '2 minutes',
    }, () => updatePipelineFolderLink(env, workspace, folders.webUrl))

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
          if (prior?.archive_status === 'archived' && prior.sharepoint_item_id) return { ok: true, reused: true }
          const attachment = await fetchSAMAttachment(env, sourceUrl, index)
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
          return { ok: true }
        })
      } catch (error) {
        await step.do(`Record failed SAM attachment ${index + 1}`, () => recordWorkspaceFile(env.EBUY_DB, {
            id,
            opportunityKey,
            sourceNoticeId: notice.noticeId,
            sourceUrl,
            fileName: `SAM attachment ${index + 1}`,
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
