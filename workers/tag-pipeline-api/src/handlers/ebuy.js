import {
  ebuyStorageStatus,
  getEbuyConnectionStatus,
  getEbuyOpportunity,
  hasRunningEbuySync,
  listEbuyOpportunities,
  purgeExpiredEbuyRecords,
  recordArchivedEbuyAttachment,
  updateEbuyReviewState,
} from '../lib/ebuyRepository.js'
import { connectEbuyAccount, disconnectEbuyAccount, testStoredEbuyConnection } from '../lib/ebuyConnection.js'
import { archiveEbuyFile, deleteArchivedEbuyFile } from '../lib/sharepointArchive.js'

const FIXTURE_ATTACHMENT = {
  id: 'RFI-DEMO-001-archive-test',
  requestId: 'RFI-DEMO-001',
  fileName: 'TAG_eBuy_Archive_Test.txt',
  contentType: 'text/plain; charset=utf-8',
}

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

async function startLiveSync(env, source = 'manual', scheduledTime = null) {
  const db = requireDatabase(env)
  if (!env.EBUY_SYNC_WORKFLOW) {
    return json({ error: 'The eBuy sync Workflow is not configured', code: 'ebuy_workflow_not_configured' }, 503)
  }
  const connection = await getEbuyConnectionStatus(db, Boolean(env.EBUY_CREDENTIAL_ENCRYPTION_KEY))
  if (!connection.configured) return json({ error: 'Connect the company GSA eBuy account in Settings first', code: 'ebuy_not_connected' }, 409)
  if (await hasRunningEbuySync(db)) return json({ ok: true, started: false, alreadyRunning: true, message: 'An eBuy synchronization is already running.' }, 202)
  const slot = scheduledTime ? Math.floor(Number(scheduledTime) / (6 * 60 * 60 * 1000)) : crypto.randomUUID()
  const instanceId = `ebuy-live-${slot}`
  const created = await env.EBUY_SYNC_WORKFLOW.createBatch([{
    id: instanceId,
    params: { mode: 'live', source },
    retention: { successRetention: '3 days', errorRetention: '7 days' },
  }])
  return json({ ok: true, started: created.length > 0, instanceId, mode: 'live' }, 202)
}

export async function startScheduledEbuySync(env, scheduledTime) {
  if (!env.EBUY_DB || !env.EBUY_SYNC_WORKFLOW || !env.EBUY_CREDENTIAL_ENCRYPTION_KEY) return { started: false, reason: 'not_configured' }
  const connection = await getEbuyConnectionStatus(env.EBUY_DB, true)
  if (!connection.configured) return { started: false, reason: 'not_connected' }
  const response = await startLiveSync(env, 'scheduled', scheduledTime)
  return response.json()
}

async function archiveFixtureAttachment(env) {
  const db = requireDatabase(env)
  if (!await getEbuyOpportunity(db, FIXTURE_ATTACHMENT.requestId)) {
    return json({ error: 'Synchronize the test eBuy archive before archiving its attachment', code: 'ebuy_fixture_required' }, 409)
  }

  const archivedAt = new Date().toISOString()
  const content = new TextEncoder().encode([
    'TAG CRM eBuy attachment archive test',
    '',
    `Request ID: ${FIXTURE_ATTACHMENT.requestId}`,
    `Archived at: ${archivedAt}`,
    '',
    'This harmless test file verifies the Cloudflare Worker, Microsoft Graph, SharePoint, and D1 attachment path.',
  ].join('\n'))
  const sourceHash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', content))]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
  const archived = await archiveEbuyFile(env, {
    requestId: FIXTURE_ATTACHMENT.requestId,
    fileName: FIXTURE_ATTACHMENT.fileName,
    contentType: FIXTURE_ATTACHMENT.contentType,
    body: content,
  })
  const attachment = await recordArchivedEbuyAttachment(db, {
    ...FIXTURE_ATTACHMENT,
    byteSize: content.byteLength,
    sourceHash,
    driveId: archived.driveId,
    itemId: archived.itemId,
    webUrl: archived.webUrl,
  })
  return json({ ok: true, attachment })
}

export async function getEbuyStatus(env) {
  const storage = await ebuyStorageStatus(env.EBUY_DB)
  const connection = await getEbuyConnectionStatus(env.EBUY_DB, Boolean(env.EBUY_CREDENTIAL_ENCRYPTION_KEY))
  const connector = {
    enabled: Boolean(connection.configured),
    mode: connection.configured ? 'live' : 'fixture',
    message: connection.configured
      ? connection.status === 'error'
        ? connection.lastErrorMessage || 'The latest eBuy connection attempt needs attention.'
        : 'The company eBuy account is connected for autonomous synchronization.'
      : connection.encryptionConfigured
        ? 'The secure connection is ready for company eBuy credentials.'
        : 'Add the Worker encryption secret before connecting the company eBuy account.',
    automationReady: Boolean(connection.configured && connection.encryptionConfigured),
    connection,
  }
  return { ...storage, connector, sharepointArchive: Boolean(env.MS_TENANT_ID && env.MS_CLIENT_ID && env.MS_CLIENT_SECRET) }
}

export async function handleEbuy(req, env, identity = {}) {
  const url = new URL(req.url)
  const path = url.pathname
  try {
    if (path === '/ebuy/status' && req.method === 'GET') return json(await getEbuyStatus(env))
    if (path === '/ebuy/sync/status' && req.method === 'GET') return json(await getEbuyStatus(env))
    if (path === '/ebuy/connection' && req.method === 'POST') {
      const body = await req.json().catch(() => ({}))
      const connection = await connectEbuyAccount(env, body, identity.name || identity.userId || '')
      return json({ ok: true, connection })
    }
    if (path === '/ebuy/connection' && req.method === 'DELETE') {
      await disconnectEbuyAccount(env)
      return json({ ok: true })
    }
    if (path === '/ebuy/connection/test' && req.method === 'POST') {
      return json({ ok: true, ...(await testStoredEbuyConnection(env)) })
    }
    if (path === '/ebuy/sync' && req.method === 'POST') return startLiveSync(env)
    if (path === '/ebuy/sync/fixture' && req.method === 'POST') {
      requireDatabase(env)
      return startFixtureSync(env)
    }
    if (path === '/ebuy/archive/test-attachment' && req.method === 'POST') {
      requireDatabase(env)
      return archiveFixtureAttachment(env)
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
