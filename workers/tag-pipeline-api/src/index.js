/**
 * TAG Pipeline API — Cloudflare Worker
 *
 * Routes:
 *   POST /notify      → Teams webhook proxy
 *   POST /ai/chat     → Groq AI proxy with context assembly
 *   GET  /sam/search  → Databank/SAM API proxy (stubbed, ready for implementation)
 *   GET  /health      → Health check
 */

import { handleNotify }  from './handlers/notify.js'
import { handleAIChat }  from './handlers/ai.js'
import { handleSAM }     from './handlers/sam.js'

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
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
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
      if (path === '/health' && req.method === 'GET') {
        response = json({ status: 'ok', timestamp: new Date().toISOString() })

      } else if (path === '/notify' && req.method === 'POST') {
        response = await handleNotify(req, env)

      } else if (path === '/ai/chat' && req.method === 'POST') {
        response = await handleAIChat(req, env)

      } else if (path === '/sam/search' && req.method === 'GET') {
        response = await handleSAM(req, env)

      } else {
        response = json({ error: 'Not found' }, 404)
      }
    } catch (err) {
      console.error('[Worker] Unhandled error:', err)
      response = json({ error: 'Internal server error', message: err.message }, 500)
    }

    return cors(env, req, response)
  },
}
