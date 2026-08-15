import {
  acknowledgeOpportunityAlert,
  alertStorageReady,
  listOpportunityAlerts,
} from '../lib/opportunityAlerts.js'

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
}

export async function handleOpportunityAlerts(req, env) {
  if (!env.EBUY_DB || !(await alertStorageReady(env.EBUY_DB))) {
    return json({ error: 'Apply the latest D1 migration to enable opportunity alerts.' }, 503)
  }
  const url = new URL(req.url)
  if (url.pathname === '/opportunity-alerts' && req.method === 'GET') {
    return json({ alerts: await listOpportunityAlerts(env.EBUY_DB, url.searchParams.get('opportunityKey') || '') })
  }
  const match = url.pathname.match(/^\/opportunity-alerts\/([^/]+)\/([^/]+)\/acknowledge$/)
  if (match && req.method === 'POST') {
    const body = await req.json().catch(() => ({}))
    const alert = await acknowledgeOpportunityAlert(
      env.EBUY_DB,
      decodeURIComponent(match[1]),
      decodeURIComponent(match[2]),
      body.fingerprint || '',
    )
    return alert ? json({ ok: true, alert }) : json({ error: 'Alert not found' }, 404)
  }
  return json({ error: 'Not found' }, 404)
}
