import {
  acknowledgeOpportunityAlert,
  alertStorageReady,
  listOpportunityAlerts,
} from '../lib/opportunityAlerts.js'

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
}

function normalized(value) {
  return String(value || '').trim().replace(/^'+/, '').toLowerCase()
}

async function enrichSAMAlerts(env, alerts) {
  if (!env.CACHE || !(alerts || []).some((alert) => ['sam_change', 'sam_files'].includes(alert.type))) return alerts
  try {
    const snapshot = await env.CACHE.get('sam_monitor_status_snapshot_v1', 'json')
    const watches = Array.isArray(snapshot?.watches) ? snapshot.watches : []
    return alerts.map((alert) => {
      if (!['sam_change', 'sam_files'].includes(alert.type)) return alert
      const alertKey = normalized(alert.opportunityKey)
      const watch = watches.find((candidate) => [
        candidate.opportunityKey,
        candidate.noticeId,
        candidate.solicitationNumber,
      ].some((value) => normalized(value) === alertKey))
      if (!watch) return alert
      return {
        ...alert,
        details: {
          ...alert.details,
          opportunityTitle: alert.details?.opportunityTitle || watch.title || watch.latest?.title || '',
          noticeId: alert.details?.noticeId || watch.noticeId || watch.latest?.noticeId || '',
          solicitationNumber: alert.details?.solicitationNumber || watch.solicitationNumber || watch.latest?.solicitationNumber || '',
          discoveryRowIndex: alert.details?.discoveryRowIndex ?? watch.rowIndex ?? null,
        },
      }
    })
  } catch (error) {
    console.warn(JSON.stringify({ event: 'opportunity_alert_sam_enrichment_failed', message: error.message }))
    return alerts
  }
}

export async function handleOpportunityAlerts(req, env) {
  if (!env.EBUY_DB || !(await alertStorageReady(env.EBUY_DB))) {
    return json({ error: 'Apply the latest D1 migration to enable opportunity alerts.' }, 503)
  }
  const url = new URL(req.url)
  if (url.pathname === '/opportunity-alerts' && req.method === 'GET') {
    const alerts = await listOpportunityAlerts(env.EBUY_DB, url.searchParams.get('opportunityKey') || '')
    return json({ alerts: await enrichSAMAlerts(env, alerts) })
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
