import {
  claimWorkspaceRun,
  ensureWorkspaceRequest,
  getWorkspace,
  resetWorkspaceForRebuild,
  updateWorkspace,
  workspaceStorageStatus,
} from '../lib/opportunityWorkspaceRepository.js'
import {
  inspectWorkspaceRoot,
  listWorkspaceChildren,
  resolveWorkspaceFolderLink,
} from '../lib/opportunityWorkspaceSharePoint.js'
import { applyLegacyFolderLinks, scanLegacyOpportunityFolders } from '../lib/legacyFolderMigration.js'

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
  try {
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
  } catch (error) {
    console.warn(JSON.stringify({
      event: 'opportunity_workspace_link_not_adopted',
      opportunityKey: workspace.opportunityKey,
      message: error.message,
    }))
    return workspace
  }
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
      if (!workspace.rootFolderId && body.folderLink) {
        workspace = await adoptExistingFolderIfAvailable(env, storage, workspace, body.folderLink)
      }
      const result = await startWorkflow(env, workspace)
      return json({ ok: true, ...result }, result.started ? 202 : 200)
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

    const detailMatch = path.match(/^\/opportunity-workspaces\/([^/]+)$/)
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
