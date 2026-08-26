/**
 * TAG Pipeline API — Cloudflare Worker
 *
 * Routes:
 *   POST /notify      → Teams webhook proxy
 *   POST /ai/chat     → Groq AI proxy with context assembly
 *   GET  /sam/search  → Databank/SAM API proxy (stubbed, ready for implementation)
 *   GET  /health      → Health check
 */

import { handleNotify }             from './handlers/notify.js'
import {
  getCapabilitiesStatus,
  handleAIChat,
  handlePeopleSearchQueries,
  manuallyRefreshCapabilities,
  refreshCapabilitiesIfChanged,
} from './handlers/ai.js'
import { handleSAM, startScheduledSAMPull } from './handlers/sam.js'
import { handleAwards } from './handlers/awards.js'
import { handleExpiringContracts, startExpiringContractsRefresh } from './handlers/expiringContracts.js'
import { handleEntityEightA } from './handlers/entities.js'
import { handleSAMMonitor, runSAMMonitorCheck } from './handlers/samMonitor.js'
import { handleRFIFollowUpMonitor, runRFIFollowUpMonitor } from './handlers/rfiFollowUpMonitor.js'
import { getNotificationMonitorStatus, runScheduledNotifications } from './handlers/notificationMonitor.js'
import { getEbuyStatus, handleEbuy, startScheduledEbuySync } from './handlers/ebuy.js'
import { purgeExpiredEbuyRecords } from './lib/ebuyRepository.js'
import { deleteArchivedEbuyFile, deleteEmptySAMArchiveFolder } from './lib/sharepointArchive.js'
import { AuthError, verifyEntraRequest } from './lib/auth.js'
import { getAutomationHealth } from './lib/automationHealth.js'
import { handleOpportunityWorkspaces } from './handlers/opportunityWorkspaces.js'
import { handlePartnerWorkspaces } from './handlers/partnerWorkspaces.js'
import { handleOpportunityAlerts } from './handlers/opportunityAlerts.js'
import { purgeOldOpportunityAlertEvents } from './lib/opportunityAlerts.js'
import { purgeDismissedSAMArchives } from './lib/samArchiveRepository.js'
import { handleTransactionCoding, TRANSACTION_CODING_HTTP_METHODS } from './handlers/transactionCoding.js'
import { purgeExpiredTransactionCodingData } from './lib/transactionCodingRepository.js'
import { runPendingAwardMonitor, runQuarterlyExpirationReconciliation } from './handlers/pipelineMonitors.js'

// ── CORS helpers ───────────────────────────────────────────────────────────

function corsHeaders(env, req) {
  const origin = req.headers.get('Origin') || ''
  const allowed = env.ALLOWED_ORIGIN || ''

  // Allow exact match or localhost for development
  const isAllowed =
    origin === allowed ||
    origin.startsWith('http://localhost') ||
    origin.startsWith('http://127.0.0.1')

  return {
    'Access-Control-Allow-Origin':  isAllowed ? origin : allowed,
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age':       '86400',
  }
}

function cors(env, req, response) {
  const headers = new Headers(response.headers)
  Object.entries(corsHeaders(env, req)).forEach(([k, v]) => headers.set(k, v))
  return new Response(response.body, { status: response.status, headers })
}

function preflight(env, req) {
  return new Response(null, { status: 204, headers: corsHeaders(env, req) })
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

// ── Router ─────────────────────────────────────────────────────────────────

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url)
    const path = url.pathname

    // Handle CORS preflight for all routes
    if (req.method === 'OPTIONS') return preflight(env, req)

    let response

    try {
      // CORS only controls browser behavior. It does not prevent someone from
      // calling the Worker directly, so every application route must prove it
      // came from an authenticated user of this Entra application. Health is
      // deliberately public for deployment monitoring; scheduled handlers do
      // not pass through fetch() and are unaffected.
      const identity = path !== '/health' ? await verifyEntraRequest(req, env) : null

      if (path === '/health' && req.method === 'GET') {
        response = json({ status: 'ok', timestamp: new Date().toISOString() })

      } else if (path === '/notify' && req.method === 'POST') {
        response = await handleNotify(req, env)

      } else if (path === '/ai/chat' && req.method === 'POST') {
        response = await handleAIChat(req, env)

      } else if (path === '/ai/people-search-queries' && req.method === 'POST') {
        response = await handlePeopleSearchQueries(req, env)

      } else if (path === '/ai/history' && (req.method === 'GET' || req.method === 'DELETE')) {
        response = await handleAIChat(req, env)

      } else if (path === '/integrations/status' && req.method === 'GET') {
        const [capabilities, notifications, automation, ebuy] = await Promise.all([
          getCapabilitiesStatus(env),
          getNotificationMonitorStatus(env),
          getAutomationHealth(env),
          getEbuyStatus(env),
        ])
        response = json({ capabilities, notifications, automation, ebuy })

      } else if (path === '/integrations/capabilities/refresh' && req.method === 'POST') {
        const result = await manuallyRefreshCapabilities(env)
        response = json({
          ok: result.ok,
          changed: Boolean(result.changed),
          checked: Boolean(result.checked),
          throttled: Boolean(result.throttled),
          error: result.error || null,
          capabilities: await getCapabilitiesStatus(env),
        }, result.ok ? 200 : 502)

      } else if (path === '/sam/key-status' && req.method === 'GET') {
        response = await handleSAM(req, env, ctx)

      } else if (path === '/sam/run-status' && req.method === 'GET') {
        response = await handleSAM(req, env, ctx)

      } else if (path === '/sam/follow-ups' && req.method === 'GET') {
        response = await handleSAM(req, env, ctx)

      } else if (path === '/sam/debug' && req.method === 'GET') {
        response = await handleSAM(req, env, ctx)

      } else if (path === '/sam/trigger' && req.method === 'POST') {
        response = await handleSAM(req, env, ctx)

      } else if (path === '/sam/search' && req.method === 'GET') {
        response = await handleSAM(req, env, ctx)

      } else if (path === '/sam/opportunity' && req.method === 'GET') {
        response = await handleSAM(req, env, ctx)

      } else if (path.startsWith('/sam/archive') && ['GET', 'POST'].includes(req.method)) {
        response = await handleSAM(req, env, ctx)

      } else if (path.startsWith('/sam/changes/') && ['GET', 'POST'].includes(req.method)) {
        response = await handleSAMMonitor(req, env)

      } else if (path.startsWith('/sam/follow-up-monitor/') && ['GET', 'POST'].includes(req.method)) {
        response = await handleRFIFollowUpMonitor(req, env)

      } else if (path === '/awards/lookup' && req.method === 'GET') {
        response = await handleAwards(req, env)

      } else if (path.startsWith('/sam/expiring-contracts/') && ['GET', 'POST', 'DELETE'].includes(req.method)) {
        response = await handleExpiringContracts(req, env)

      } else if (path === '/entities/8a' && req.method === 'GET') {
        response = await handleEntityEightA(req, env)

      } else if (path.startsWith('/ebuy/') && ['GET', 'POST', 'PATCH', 'DELETE'].includes(req.method)) {
        response = await handleEbuy(req, env, identity)

      } else if (path.startsWith('/opportunity-workspaces') && ['GET', 'POST', 'DELETE'].includes(req.method)) {
        response = await handleOpportunityWorkspaces(req, env)

      } else if (path.startsWith('/opportunity-alerts') && ['GET', 'POST'].includes(req.method)) {
        response = await handleOpportunityAlerts(req, env)

      } else if (path.startsWith('/partner-workspaces') && ['GET', 'POST'].includes(req.method)) {
        response = await handlePartnerWorkspaces(req, env)

      } else if (path.startsWith('/transaction-coding') && TRANSACTION_CODING_HTTP_METHODS.includes(req.method)) {
        response = await handleTransactionCoding(req, env, identity)

      } else {
        response = json({ error: 'Not found' }, 404)
      }
    } catch (err) {
      console.error('[Worker] Unhandled error:', err)
      if (err instanceof AuthError) {
        response = json({ error: err.message, code: err.code }, err.status)
      } else {
        response = json({ error: 'Internal server error', message: err.message }, 500)
      }
    }

    return cors(env, req, response)
  },

  // All scheduled times are UTC. Nigeria is UTC+1 year-round. SAM and eBuy
  // opportunity synchronization share the four six-hour weekday checkpoints;
  // follow-on checks run once each weekday and response-deadline reminders
  // may still run on weekends.
  async scheduled(controller, env, ctx) {
    if (controller.cron === '0 0,6,12,18 * * *') {
      const scheduledDate = new Date(controller.scheduledTime)
      const scheduledHour = scheduledDate.getUTCHours()
      const weekday = scheduledDate.getUTCDay()
      const isWeekday = weekday >= 1 && weekday <= 5

      if (isWeekday) {
        ctx.waitUntil(startScheduledEbuySync(env, controller.scheduledTime).catch((error) => {
          console.error(JSON.stringify({ event: 'ebuy_scheduled_start_failed', code: error.code || null, message: error.message }))
        }))
        ctx.waitUntil(startScheduledSAMPull(env, controller.scheduledTime))
      }

      // SAM change monitoring keeps its existing twice-daily cadence.
      if ([0, 12].includes(scheduledHour)) {
        ctx.waitUntil((async () => {
          const run = await env.CACHE?.get('sam_monitor_run', 'json')
          const cursor = run?.nextCursor ?? 0
          return runSAMMonitorCheck(env, cursor, { scheduled: true })
        })())
      }

      if (scheduledHour === 0 && [1, 4].includes(weekday)) {
        ctx.waitUntil(startExpiringContractsRefresh(env, {
          scheduledTime: controller.scheduledTime,
          source: 'scheduled',
        }))
      }

      if (scheduledHour === 12 && isWeekday) {
        ctx.waitUntil(runRFIFollowUpMonitor(env))
        ctx.waitUntil(runPendingAwardMonitor(env).catch((error) => {
          console.error(JSON.stringify({ event: 'pending_award_monitor_failed', message: error.message }))
        }))
        ctx.waitUntil(runQuarterlyExpirationReconciliation(env, controller.scheduledTime).catch((error) => {
          console.error(JSON.stringify({ event: 'pipeline_expiration_reconciliation_failed', message: error.message }))
        }))
      }
    }
    // One minute after the workload-heavy SAM pull, compare the capabilities
    // document eTag. It downloads the DOCX only after a source change.
    if (controller.cron === '1 12 * * *') {
      ctx.waitUntil(refreshCapabilitiesIfChanged(env))
    }
    // Teams reminders retain their dedicated 2:01 PM WAT run.
    if (controller.cron === '1 13 * * *') {
      ctx.waitUntil(runScheduledNotifications(env))
      // Retention is intentionally modest and only runs once each Monday.
      // Protected records remain until a user explicitly changes their state.
      if (new Date(controller.scheduledTime).getUTCDay() === 1 && env.EBUY_DB) {
        ctx.waitUntil(purgeExpiredEbuyRecords(env.EBUY_DB, {
          deleteFile: (driveId, itemId) => deleteArchivedEbuyFile(env, driveId, itemId),
        }).catch((error) => {
          console.error(JSON.stringify({ event: 'ebuy_retention_failed', message: error.message }))
        }))
        ctx.waitUntil(purgeOldOpportunityAlertEvents(env.EBUY_DB).catch((error) => {
          console.error(JSON.stringify({ event: 'opportunity_alert_retention_failed', message: error.message }))
        }))
        ctx.waitUntil(purgeDismissedSAMArchives(env.EBUY_DB, {
          deleteFile: (driveId, itemId) => deleteArchivedEbuyFile(env, driveId, itemId),
          deleteFolder: (driveId, opportunityKey) => deleteEmptySAMArchiveFolder(env, driveId, opportunityKey),
        }).catch((error) => {
          console.error(JSON.stringify({ event: 'sam_archive_retention_failed', message: error.message }))
        }))
        ctx.waitUntil(purgeExpiredTransactionCodingData(env.EBUY_DB).catch((error) => {
          console.error(JSON.stringify({ event: 'transaction_coding_retention_failed', message: error.message }))
        }))
      }
    }
  },
}

export { SAMPullWorkflow } from './workflows/samPull.js'
export { ExpiringContractsWorkflow } from './workflows/expiringContracts.js'
export { EbuySyncWorkflow } from './workflows/ebuySync.js'
export { OpportunityWorkspaceWorkflow } from './workflows/opportunityWorkspace.js'
export { SAMArchiveWorkflow } from './workflows/samArchive.js'
