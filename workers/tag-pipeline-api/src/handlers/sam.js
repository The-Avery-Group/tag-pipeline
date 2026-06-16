/**
 * sam.js — Databank / SAM.gov API proxy (stub)
 *
 * Ready for implementation once API details are confirmed.
 * Will proxy contract award data queries to the Databank API,
 * with optional KV caching to avoid hammering rate limits.
 *
 * Planned query params:
 *   naics      — NAICS code (e.g. "541511")
 *   agency     — Agency name or code
 *   dateFrom   — Award date range start (YYYY-MM-DD)
 *   dateTo     — Award date range end   (YYYY-MM-DD)
 *   limit      — Max results (default 20)
 *
 * Planned response shape:
 * {
 *   awards: [
 *     {
 *       recipient_name: string,
 *       award_amount: number,
 *       award_date: string,
 *       naics_code: string,
 *       agency_name: string,
 *       description: string,
 *       contract_number: string,
 *     }
 *   ],
 *   total: number,
 *   cached: boolean,
 * }
 */

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

// Cache TTL in seconds (24 hours — award data doesn't change minute to minute)
const CACHE_TTL = 60 * 60 * 24

export async function handleSAM(req, env) {
  // ── Not yet implemented ───────────────────────────────────────────────────
  // Remove this block and implement below once Databank API details confirmed.
  return json({
    stub: true,
    message: 'Databank integration not yet implemented. Add DATABANK_API_KEY secret and implement this handler.',
    awards: [],
    total: 0,
    cached: false,
  })

  /* ── Implementation template (uncomment when ready) ─────────────────────

  if (!env.DATABANK_API_KEY) {
    return json({ error: 'Databank not configured' }, 503)
  }

  const url = new URL(req.url)
  const naics    = url.searchParams.get('naics')    || ''
  const agency   = url.searchParams.get('agency')   || ''
  const dateFrom = url.searchParams.get('dateFrom') || ''
  const dateTo   = url.searchParams.get('dateTo')   || ''
  const limit    = parseInt(url.searchParams.get('limit') || '20', 10)

  // Build cache key from query params
  const cacheKey = `sam:${naics}:${agency}:${dateFrom}:${dateTo}:${limit}`

  // Check KV cache if available
  if (env.CACHE) {
    const cached = await env.CACHE.get(cacheKey, 'json')
    if (cached) return json({ ...cached, cached: true })
  }

  // TODO: Replace with actual Databank API endpoint and query structure
  const databankUrl = new URL('https://api.databank.example.com/awards')
  if (naics)    databankUrl.searchParams.set('naics_code', naics)
  if (agency)   databankUrl.searchParams.set('agency_name', agency)
  if (dateFrom) databankUrl.searchParams.set('date_from', dateFrom)
  if (dateTo)   databankUrl.searchParams.set('date_to', dateTo)
  databankUrl.searchParams.set('limit', String(limit))

  try {
    const res = await fetch(databankUrl.toString(), {
      headers: {
        'Authorization': `Bearer ${env.DATABANK_API_KEY}`,
        'Accept': 'application/json',
      },
    })

    if (!res.ok) {
      return json({ error: `Databank API error: ${res.status}` }, 502)
    }

    const data = await res.json()

    // TODO: Normalize response shape to match planned structure above
    const result = {
      awards: data.results || data.awards || [],
      total:  data.count  || data.total  || 0,
      cached: false,
    }

    // Cache in KV
    if (env.CACHE) {
      await env.CACHE.put(cacheKey, JSON.stringify(result), { expirationTtl: CACHE_TTL })
    }

    return json(result)
  } catch (err) {
    console.error('[SAM] Fetch failed:', err)
    return json({ error: err.message }, 502)
  }

  ── End implementation template ── */
}
