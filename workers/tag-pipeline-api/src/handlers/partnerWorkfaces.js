import {
  applyPartnerFolderLinks,
  createPartnerUploadSession,
  listPartnerWorkspaceChildren,
  removePartnerUploads,
  scanPartnerFolders,
} from '../lib/partnerWorkspaceSharePoint.js'

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
}

export async function handlePartnerWorkspaces(req, env) {
  const url = new URL(req.url)
  const path = url.pathname
  try {
    if (path === '/partner-workspaces/migration/scan' && req.method === 'POST') {
      return json(await scanPartnerFolders(env))
    }
    if (path === '/partner-workspaces/migration/apply' && req.method === 'POST') {
      const body = await req.json().catch(() => ({}))
      return json({ ok: true, ...(await applyPartnerFolderLinks(env, body.mappings || [])) })
    }

    const filesMatch = path.match(/^\/partner-workspaces\/([^/]+)\/files$/)
    if (filesMatch && req.method === 'GET') {
      return json(await listPartnerWorkspaceChildren(
        env,
        decodeURIComponent(filesMatch[1]),
        url.searchParams.get('parentId') || '',
      ))
    }

    const rollbackMatch = path.match(/^\/partner-workspaces\/([^/]+)\/uploads\/rollback$/)
    if (rollbackMatch && req.method === 'POST') {
      const body = await req.json().catch(() => ({}))
      return json({ ok: true, ...(await removePartnerUploads(env, decodeURIComponent(rollbackMatch[1]), body.itemIds || [])) })
    }

    const uploadsMatch = path.match(/^\/partner-workspaces\/([^/]+)\/uploads$/)
    if (uploadsMatch && req.method === 'POST') {
      const body = await req.json().catch(() => ({}))
      return json({ upload: await createPartnerUploadSession(env, decodeURIComponent(uploadsMatch[1]), body) })
    }

    return json({ error: 'Not found' }, 404)
  } catch (error) {
    console.warn(JSON.stringify({ event: 'partner_workspace_request_failed', path, message: error.message }))
    return json({ error: error.message, code: error.code || 'partner_workspace_failed' }, error.status || 500)
  }
}
