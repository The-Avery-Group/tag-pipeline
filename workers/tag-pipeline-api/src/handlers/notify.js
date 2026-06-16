/**
 * notify.js — Teams webhook proxy
 *
 * Receives a notification payload from the frontend and forwards it
 * to the Teams incoming webhook URL stored as a Worker secret.
 *
 * Expected request body:
 *   { type: string, payload: object }
 *
 * `type` maps to a card builder — the frontend sends minimal data,
 * the Worker assembles the full Adaptive Card so card structure
 * never leaks to the client.
 */

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

// ── Adaptive Card builder ──────────────────────────────────────────────────

function buildCard({ title, subtitle, facts = [], deepLinkUrl, color = 'accent' }) {
  return {
    type: 'message',
    attachments: [
      {
        contentType: 'application/vnd.microsoft.card.adaptive',
        content: {
          $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
          type: 'AdaptiveCard',
          version: '1.4',
          body: [
            {
              type: 'Container',
              style: color,
              items: [
                { type: 'TextBlock', text: title, weight: 'Bolder', size: 'Medium', wrap: true },
                ...(subtitle
                  ? [{ type: 'TextBlock', text: subtitle, isSubtle: true, wrap: true, spacing: 'None' }]
                  : []),
              ],
            },
            ...(facts.length > 0
              ? [{ type: 'FactSet', facts: facts.map(([t, v]) => ({ title: t, value: String(v ?? '—') })) }]
              : []),
          ],
          actions: deepLinkUrl
            ? [{ type: 'Action.OpenUrl', title: 'Open in Pipeline Manager', url: deepLinkUrl }]
            : [],
        },
      },
    ],
  }
}

// ── Card type builders ─────────────────────────────────────────────────────

const APP_BASE = (env) => env.ALLOWED_ORIGIN || ''

function cardForType(type, payload, env) {
  const base = APP_BASE(env)

  switch (type) {
    case 'new_opportunity':
      return buildCard({
        title: '🆕 New Opportunity Added',
        subtitle: payload.title,
        facts: [
          ['Contract #', payload.contractNumber],
          ['Agency', payload.agency],
          ['Phase', payload.phase],
          ['Value', payload.value],
          ['Assigned To', payload.assignedTo],
        ],
        deepLinkUrl: `${base}/tag-pipeline/opportunities/${encodeURIComponent(payload.contractNumber)}`,
        color: 'good',
      })

    case 'phase_change':
      return buildCard({
        title: '🔄 Opportunity Phase Changed',
        subtitle: payload.title,
        facts: [
          ['Contract #', payload.contractNumber],
          ['From', payload.fromPhase],
          ['To', payload.toPhase],
          ['Assigned To', payload.assignedTo],
        ],
        deepLinkUrl: `${base}/tag-pipeline/opportunities/${encodeURIComponent(payload.contractNumber)}`,
        color: 'accent',
      })

    case 'task_created':
      return buildCard({
        title: '✅ New Task Created',
        subtitle: payload.title,
        facts: [
          ['Contract', payload.contractTitle || payload.contractNumber],
          ['Assigned to', payload.assignedTo],
          ['Due date', payload.dueDate],
          ['Priority', payload.priority],
        ],
        deepLinkUrl: `${base}/tag-pipeline/tasks`,
        color: 'good',
      })

    case 'overdue_summary':
      return buildCard({
        title: `🚨 ${payload.count} Overdue Task${payload.count > 1 ? 's' : ''}`,
        subtitle: payload.count > payload.items.length
          ? `Showing ${payload.items.length} of ${payload.count}`
          : 'Requires immediate attention',
        facts: [
          ...payload.items.map((t) => [t.contractTitle || t.contractNumber, `${t.title} · Due ${t.dueDate}`]),
          ...(payload.count > payload.items.length ? [['', `…and ${payload.count - payload.items.length} more`]] : []),
        ],
        deepLinkUrl: `${base}/tag-pipeline/tasks`,
        color: 'attention',
      })

    case 'due_soon_summary':
      return buildCard({
        title: `⏰ ${payload.count} Task${payload.count > 1 ? 's' : ''} Due Tomorrow`,
        subtitle: payload.count > payload.items.length
          ? `Showing ${payload.items.length} of ${payload.count}`
          : 'Due tomorrow',
        facts: [
          ...payload.items.map((t) => [t.contractTitle || t.contractNumber, `${t.title} · ${t.assignedTo || 'Unassigned'}`]),
          ...(payload.count > payload.items.length ? [['', `…and ${payload.count - payload.items.length} more`]] : []),
        ],
        deepLinkUrl: `${base}/tag-pipeline/tasks`,
        color: 'warning',
      })

    case 'rfi_followup':
      return buildCard({
        title: `📋 ${payload.count} RFI Follow-Up${payload.count > 1 ? 's' : ''} Due`,
        subtitle: '3 weeks since submission — follow up recommended',
        facts: [
          ...payload.items.map((o) => [o.agency || o.contractNumber, o.title]),
          ...(payload.count > payload.items.length ? [['', `…and ${payload.count - payload.items.length} more`]] : []),
        ],
        deepLinkUrl: `${base}/tag-pipeline/opportunities`,
        color: 'warning',
      })

    case 'stale_opportunities':
      return buildCard({
        title: `⚠️ ${payload.count} Stale Opportunit${payload.count > 1 ? 'ies' : 'y'}`,
        subtitle: 'No activity in the past 7 days',
        facts: [
          ...payload.items.map((o) => [o.phase || '—', o.title]),
          ...(payload.count > payload.items.length ? [['', `…and ${payload.count - payload.items.length} more`]] : []),
        ],
        deepLinkUrl: `${base}/tag-pipeline/opportunities`,
        color: 'warning',
      })

    default:
      return null
  }
}

// ── Handler ────────────────────────────────────────────────────────────────

export async function handleNotify(req, env) {
  if (!env.TEAMS_WEBHOOK_URL) {
    console.warn('[Notify] TEAMS_WEBHOOK_URL secret not set')
    return json({ ok: false, error: 'Webhook not configured' }, 503)
  }

  let body
  try {
    body = await req.json()
  } catch {
    return json({ error: 'Invalid JSON body' }, 400)
  }

  const { type, payload } = body
  if (!type || !payload) {
    return json({ error: 'Missing type or payload' }, 400)
  }

  const card = cardForType(type, payload, env)
  if (!card) {
    return json({ error: `Unknown notification type: ${type}` }, 400)
  }

  try {
    const res = await fetch(env.TEAMS_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(card),
    })
    if (!res.ok) {
      console.error('[Notify] Teams webhook returned', res.status)
      return json({ ok: false, error: `Teams returned ${res.status}` }, 502)
    }
    return json({ ok: true })
  } catch (err) {
    console.error('[Notify] Fetch failed:', err)
    return json({ ok: false, error: err.message }, 502)
  }
}
