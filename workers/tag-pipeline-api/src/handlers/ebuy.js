import { getEbuyConnectorStatus, fetchEbuyWithManualSession } from '../lib/ebuyConnector.js'
import {
  ebuyStorageStatus,
  getEbuyOpportunity,
  listEbuyOpportunities,
  purgeExpiredEbuyRecords,
  updateEbuyReviewState,
} from '../lib/ebuyRepository.js'
import { deleteArchivedEbuyFile } from '../lib/sharepointArchive.js'

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
}

function requireDatabase(env) {
  if (!env.EBUY_DB) {
    const error = new Error('The eBuy archive database is not configured')
    error.status = 503
    error.code = 'ebuy_storage_not_configured'
    throw error
  }
  return env.EBUY_DB
}

async function startFixtureSync(env) {
  if (!env.EBUY_SYNC_WORKFLOW) {
    return json({ error: 'The eBuy sync Workflow is not configured', code: 'ebuy_workflow_not_configured' }, 503)
  }
  const instanceId = `ebuy-fixture-${crypto.randomUUID()}`
  const created = await env.EBUY_SYNC_WORKFLOW.createBatch([{
    id: instanceId,
    params: { mode: 'fixture' },
    retention: { successRetention: '1 day', errorRetention: '3 days' },
  }])
  return json({ ok: true, started: created.length > 0, instanceId, mode: 'fixture' }, 202)
}

export async function getEbuyStatus(env) {
  const [storage, connector] = await Promise.all([
    ebuyStorageStatus(env.EBUY_DB),
    Promise.resolve(getEbuyConnectorStatus(env)),
  ])
  return { ...storage, connector, sharepointArchive: Boolean(env.MS_TENANT_ID && env.MS_CLIENT_ID && env.MS_CLIENT_SECRET) }
}

export async function handleEbuy(req, env) {
  const url = new URL(req.url)
  const path = url.pathname
  try {
    if (path === '/ebuy/status' && req.method === 'GET') return json(await getEbuyStatus(env))
    if (path === '/ebuy/sync/status' && req.method === 'GET') return json(await getEbuyStatus(env))
    if (path === '/ebuy/sync/fixture' && req.method === 'POST') {
      requireDatabase(env)
      return startFixtureSync(env)
    }
    if (path === '/ebuy/sync/manual' && req.method === 'POST') {
      requireDatabase(env)
      if (!getEbuyConnectorStatus(env).enabled) {
        return json({ error: 'Manual eBuy sign-in is not enabled yet. Use Test archive sync for now.', code: 'live_connector_not_configured' }, 501)
      }
      const credentials = await req.json().catch(() => ({}))
      try {
        await fetchEbuyWithManualSession(env, credentials)
        return json({ error: 'The live connector returned no synchronization result', code: 'live_connector_invalid_result' }, 502)
      } finally {
        credentials.username = ''
        credentials.password = ''
        credentials.otp = ''
      }
    }
    if (path === '/ebuy/opportunities' && req.method === 'GET') {
      const db = requireDatabase(env)
      return json(await listEbuyOpportunities(db, {
        search: url.searchParams.get('q') || '',
        requestType: url.searchParams.get('type') || 'all',
        reviewState: url.searchParams.get('state') || 'all',
        lifecycle: url.searchParams.get('lifecycle') || 'all',
        includeDismissed: url.searchParams.get('includeDismissed') === 'true',
        page: url.searchParams.get('page') || 1,
        limit: url.searchParams.get('limit') || 25,
      }))
    }
    const detailMatch = path.match(/^\/ebuy\/opportunities\/([^/]+)$/)
    if (detailMatch && req.method === 'GET') {
      const opportunity = await getEbuyOpportunity(requireDatabase(env), decodeURIComponent(detailMatch[1]))
      return opportunity ? json(opportunity) : json({ error: 'eBuy opportunity not found' }, 404)
    }
    if (detailMatch && req.method === 'PATCH') {
      const body = await req.json().catch(() => ({}))
      const opportunity = await updateEbuyReviewState(
        requireDatabase(env), decodeURIComponent(detailMatch[1]), body.reviewState, body.pipelineContractId || null,
      )
      return opportunity ? json({ ok: true, opportunity }) : json({ error: 'eBuy opportunity not found' }, 404)
    }
    if (path === '/ebuy/retention/run' && req.method === 'POST') {
      return json({ ok: true, ...(await purgeExpiredEbuyRecords(requireDatabase(env), {
        deleteFile: (driveId, itemId) => deleteArchivedEbuyFile(env, driveId, itemId),
      })) })
    }
    return json({ error: 'Not found' }, 404)
  } catch (error) {
    console.error(JSON.stringify({ event: 'ebuy_request_failed', path, code: error.code || null, message: error.message }))
    return json({ error: error.message, code: error.code || 'ebuy_request_failed' }, error.status || 500)
  }
}
