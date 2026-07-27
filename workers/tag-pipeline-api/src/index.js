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
import { handleEntityEightA } from './handlers/entities.js'
import { handleSAMMonitor, runSAMMonitorCheck } from './handlers/samMonitor.js'
import { handleRFIFollowUpMonitor, runRFIFollowUpMonitor } from './handlers/rfiFollowUpMonitor.js'
import { getNotificationMonitorStatus, runScheduledNotifications } from './handlers/notificationMonitor.js'
import { AuthError, verifyEntraRequest } from './lib/auth.js'
import { getAutomationHealth } from './lib/automationHealth.js'

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
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
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
      if (path !== '/health') await verifyEntraRequest(req, env)

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
        const [capabilities, notifications, automation] = await Promise.all([
          getCapabilitiesStatus(env),
          getNotificationMonitorStatus(env),
          getAutomationHealth(env),
        ])
        response = json({ capabilities, notifications, automation })

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

      } else if (path.startsWith('/sam/changes/') && ['GET', 'POST'].includes(req.method)) {
        response = await handleSAMMonitor(req, env)

      } else if (path.startsWith('/sam/follow-up-monitor/') && ['GET', 'POST'].includes(req.method)) {
        response = await handleRFIFollowUpMonitor(req, env)

      } else if (path === '/awards/lookup' && req.method === 'GET') {
        response = await handleAwards(req, env)

      } else if (path === '/entities/8a' && req.method === 'GET') {
        response = await handleEntityEightA(req, env)

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

  // All scheduled times are UTC. Nigeria is UTC+1 year-round. SAM pulls run
  // at 12:00 UTC (1 PM WAT) on weekdays; RFI follow-up checks remain three
  // times weekly; response-deadline reminders may still run on weekends.
  async scheduled(controller, env, ctx) {
    if (controller.cron === '0 0,12 * * *') {
      ctx.waitUntil((async () => {
        const run = await env.CACHE?.get('sam_monitor_run', 'json')
        const cursor = run?.nextCursor ?? 0
        return runSAMMonitorCheck(env, cursor, { scheduled: true })
      })())

      // The noon UTC SAM-change pass also starts the independent weekday
      // pull/follow-up work, so the two jobs share one cron trigger.
      if (new Date(controller.scheduledTime).getUTCHours() === 12) {
        const weekday = new Date(controller.scheduledTime).getUTCDay()
        if (weekday >= 1 && weekday <= 5) {
          ctx.waitUntil(startScheduledSAMPull(env, controller.scheduledTime))
        }
        if ([1, 3, 5].includes(weekday)) ctx.waitUntil(runRFIFollowUpMonitor(env))
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
    }
  },
}

export { SAMPullWorkflow } from './workflows/samPull.js'
