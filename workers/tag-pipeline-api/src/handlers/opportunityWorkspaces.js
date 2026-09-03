import {
  claimWorkspaceRun,
  ensureWorkspaceRequest,
  getWorkspace,
  getWorkspaceGroup,
  linkWorkspaceMembers,
  completeWorkspaceGroup,
  completeWorkspaceGroupSplit,
  workspaceRootIsShared,
  deleteWorkspaceRecord,
  resetWorkspaceForRebuild,
  updateWorkspace,
  workspaceStorageStatus,
} from '../lib/opportunityWorkspaceRepository.js'
import {
  createReferenceMaterialUploadSession,
  inspectWorkspaceRoot,
  listWorkspaceChildren,
  listWorkspaceFlatFiles,
  removeReferenceMaterialUploads,
  resolveWorkspaceFolderLink,
  deleteWorkspaceRoot,
  shareRelatedWorkspaceFolders,
  splitRelatedWorkspaceFolders,
  updatePipelineFolderLink,
} from '../lib/opportunityWorkspaceSharePoint.js'
import { applyLegacyFolderLinks, scanLegacyOpportunityFolders } from '../lib/legacyFolderMigration.js'
import { getDocumentAnalysis, reviewDocumentFinding, startDocumentAnalysisWorkflow } from '../lib/documentAnalysis.js'

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
}

function requireStorage(env) {
  if (!env.EBUY_DB) throw Object.assign(new Error('Opportunity workspace storage is not configured'), { status: 503 })
  return env.EBUY_DB
}

async function startWorkflow(env, workspace, { force = false } = {}) {
  if (!env.OPPORTUNITY_WORKSPACE_WORKFLOW?.createBatch) {
    throw Object.assign(new Error('Opportunity workspace Workflow is not configured'), { status: 503 })
  }
  const instanceId = `opportunity-workspace-${crypto.randomUUID()}`
  const claimed = await claimWorkspaceRun(env.EBUY_DB, workspace.opportunityKey, instanceId, { force })
  if (!claimed) return { started: false, workspace: await getWorkspace(env.EBUY_DB, workspace.opportunityKey) }
  try {
    const instances = await env.OPPORTUNITY_WORKSPACE_WORKFLOW.createBatch([{
      id: instanceId,
      params: { opportunityKey: workspace.opportunityKey },
      retention: { successRetention: '7 days', errorRetention: '14 days' },
    }])
    return { started: Boolean(instances[0]), instanceId: instances[0]?.id || instanceId, workspace: await getWorkspace(env.EBUY_DB, workspace.opportunityKey) }
  } catch (error) {
    await updateWorkspace(env.EBUY_DB, workspace.opportunityKey, {
      status: 'error',
      progressPhase: 'Workspace setup could not start',
      errorMessage: error.message,
    }).catch(() => {})
    throw Object.assign(new Error(`Could not start opportunity workspace setup: ${error.message}`), { status: 502 })
  }
}

async function adoptExistingFolderIfAvailable(env, storage, workspace, folderLink) {
  if (!folderLink) return workspace
  const folder = await resolveWorkspaceFolderLink(env, folderLink)
  await resetWorkspaceForRebuild(storage, workspace.opportunityKey)
  return updateWorkspace(storage, workspace.opportunityKey, {
    status: 'new',
    progressPhase: 'Existing SharePoint workspace connected',
    sharePointDriveId: folder.driveId,
    rootFolderId: folder.rootFolderId,
    samFolderId: folder.samFolderId,
    webUrl: folder.webUrl,
    attachmentTotal: 0,
    archivedCount: 0,
    failedCount: 0,
    errorMessage: null,
    completedAt: null,
  })
}

export async function handleOpportunityWorkspaces(req, env) {
  const url = new URL(req.url)
  const path = url.pathname
  try {
    if (path === '/opportunity-workspaces/migration/scan' && req.method === 'POST') {
      const body = await req.json().catch(() => ({}))
      return json(await scanLegacyOpportunityFolders(env, body.cursor || ''))
    }

    if (path === '/opportunity-workspaces/migration/apply' && req.method === 'POST') {
      const body = await req.json().catch(() => ({}))
      return json({ ok: true, ...(await applyLegacyFolderLinks(env, body.links || [])) })
    }

    const storage = requireStorage(env)
    const storageState = await workspaceStorageStatus(storage)
    if (storageState.status !== 'ready') return json({ error: storageState.message, code: storageState.status }, 503)

    if (path === '/opportunity-workspaces' && req.method === 'POST') {
      const body = await req.json().catch(() => ({}))
      let workspace = await ensureWorkspaceRequest(storage, body)
      if (body.folderLink && (body.adoptFolderLink === true || !workspace.rootFolderId)) {
        workspace = await adoptExistingFolderIfAvailable(env, storage, workspace, body.folderLink)
      }
      const result = await startWorkflow(env, workspace)
      return json({ ok: true, ...result }, result.started ? 202 : 200)
    }

    if (path === '/opportunity-workspaces/link' && req.method === 'POST') {
      const body = await req.json().catch(() => ({}))
      if (body.relationshipType !== 'Follow-on') {
        return json({ ok: true, migrated: false, reason: 'Only Follow-on relationships reorganize SharePoint folders' })
      }
      const left = await getWorkspace(storage, body.leftOpportunityKey)
      const right = await getWorkspace(storage, body.rightOpportunityKey)
      if (!left || !right) return json({ error: 'Set up both opportunity workspaces before sharing their folder' }, 409)
      if (!left.rootFolderId || !right.rootFolderId) return json({ error: 'Both SharePoint folders must finish setup before the Follow-on relationship can reorganize them. Try linking again after setup completes.' }, 409)
      const group = await linkWorkspaceMembers(storage, left, right)
      const canonical = group.rootSource.opportunityKey === left.opportunityKey ? left : right
      const related = canonical === left ? right : left
      const folders = await shareRelatedWorkspaceFolders(env, canonical, related)
      await completeWorkspaceGroup(storage, group.groupId, folders, folders.members)
      await Promise.all([left, right].map((workspace) => updatePipelineFolderLink(env, workspace, folders.webUrl)))
      return json({ ok: true, groupId: group.groupId, workspaceUrl: folders.webUrl, members: folders.members })
    }

    if (path === '/opportunity-workspaces/unlink' && req.method === 'POST') {
      const body = await req.json().catch(() => ({}))
      const left = await getWorkspace(storage, body.leftOpportunityKey)
      const right = await getWorkspace(storage, body.rightOpportunityKey)
      if (!left || !right) return json({ ok: true, split: false, reason: 'An opportunity workspace was not found' })
      const group = await getWorkspaceGroup(storage, left.opportunityKey)
      if (!group || !group.members.some((member) => member.opportunityKey === right.opportunityKey)) {
        return json({ ok: true, split: false, reason: 'The opportunity folders are not currently shared' })
      }
      const members = await splitRelatedWorkspaceFolders(env, group.members)
      await Promise.all(members.map((member) => {
        const workspace = group.members.find((candidate) => candidate.opportunityKey === member.opportunityKey)
        return updatePipelineFolderLink(env, workspace, member.webUrl)
      }))
      await completeWorkspaceGroupSplit(storage, group.groupId, members)
      return json({ ok: true, split: true, members })
    }

    const retryMatch = path.match(/^\/opportunity-workspaces\/([^/]+)\/retry$/)
    if (retryMatch && req.method === 'POST') {
      const key = decodeURIComponent(retryMatch[1])
      const body = await req.json().catch(() => ({}))
      let workspace = body && Object.keys(body).length
        ? await ensureWorkspaceRequest(storage, { ...body, opportunityKey: key })
        : await getWorkspace(storage, key)
      if (!workspace) return json({ error: 'Opportunity workspace not found' }, 404)
      const root = await inspectWorkspaceRoot(env, workspace)
      if (!root.exists) {
        workspace = await resetWorkspaceForRebuild(storage, key)
        workspace = await adoptExistingFolderIfAvailable(env, storage, workspace, body.folderLink)
      }
      return json({ ok: true, ...(await startWorkflow(env, workspace, { force: true })) }, 202)
    }

    const filesMatch = path.match(/^\/opportunity-workspaces\/([^/]+)\/files$/)
    if (filesMatch && req.method === 'GET') {
      const workspace = await getWorkspace(storage, decodeURIComponent(filesMatch[1]))
      if (!workspace) return json({ error: 'Opportunity workspace not found' }, 404)
      return json(await listWorkspaceChildren(env, workspace, url.searchParams.get('parentId') || ''))
    }

    const fileIndexMatch = path.match(/^\/opportunity-workspaces\/([^/]+)\/file-index$/)
    if (fileIndexMatch && req.method === 'GET') {
      const workspace = await getWorkspace(storage, decodeURIComponent(fileIndexMatch[1]))
      if (!workspace) return json({ error: 'Opportunity workspace not found' }, 404)
      return json(await listWorkspaceFlatFiles(env, workspace))
    }

    const uploadRollbackMatch = path.match(/^\/opportunity-workspaces\/([^/]+)\/uploads\/rollback$/)
    if (uploadRollbackMatch && req.method === 'POST') {
      const workspace = await getWorkspace(storage, decodeURIComponent(uploadRollbackMatch[1]))
      if (!workspace) return json({ error: 'Opportunity workspace not found' }, 404)
      const body = await req.json().catch(() => ({}))
      return json({ ok: true, ...(await removeReferenceMaterialUploads(env, workspace, body.itemIds || [])) })
    }

    const analysisMatch = path.match(/^\/opportunity-workspaces\/([^/]+)\/analysis$/)
    if (analysisMatch && req.method === 'POST') {
      const key = decodeURIComponent(analysisMatch[1])
      const run = await startDocumentAnalysisWorkflow(env, { source: 'pipeline', opportunityKey: key })
      return json({ ok: true, run, analysis: await getDocumentAnalysis(env, key) }, 202)
    }
    if (analysisMatch && req.method === 'GET') {
      return json({ analysis: await getDocumentAnalysis(env, decodeURIComponent(analysisMatch[1])) })
    }
    const analysisReviewMatch = path.match(/^\/opportunity-workspaces\/([^/]+)\/analysis\/review$/)
    if (analysisReviewMatch && req.method === 'POST') {
      const analysis = await reviewDocumentFinding(env, decodeURIComponent(analysisReviewMatch[1]), await req.json().catch(() => ({})))
      return json({ ok: true, analysis })
    }

    const uploadsMatch = path.match(/^\/opportunity-workspaces\/([^/]+)\/uploads$/)
    if (uploadsMatch && req.method === 'POST') {
      const workspace = await getWorkspace(storage, decodeURIComponent(uploadsMatch[1]))
      if (!workspace) return json({ error: 'Opportunity workspace not found' }, 404)
      const body = await req.json().catch(() => ({}))
      return json({ upload: await createReferenceMaterialUploadSession(env, workspace, body) })
    }

    const detailMatch = path.match(/^\/opportunity-workspaces\/([^/]+)$/)
    if (detailMatch && req.method === 'DELETE') {
      const key = decodeURIComponent(detailMatch[1])
      const workspace = await getWorkspace(storage, key)
      if (!workspace) return json({ ok: true, deleted: false })
      const body = await req.json().catch(() => ({}))
      const shared = await workspaceRootIsShared(storage, key)
      const sharePoint = body.deleteSharePoint === true && !shared
        ? await deleteWorkspaceRoot(env, workspace)
        : { deleted: false, retained: true, reason: shared ? 'The folder is shared by related opportunities' : undefined }
      await deleteWorkspaceRecord(storage, key)
      return json({ ok: true, deleted: true, sharePoint })
    }
    if (detailMatch && req.method === 'GET') {
      const workspace = await getWorkspace(storage, decodeURIComponent(detailMatch[1]))
      return workspace ? json({ workspace }) : json({ error: 'Opportunity workspace not found' }, 404)
    }
    return json({ error: 'Not found' }, 404)
  } catch (error) {
    console.warn(JSON.stringify({ event: 'opportunity_workspace_request_failed', path, message: error.message }))
    return json({ error: error.message, code: error.code || 'opportunity_workspace_failed' }, error.status || 500)
  }
}
