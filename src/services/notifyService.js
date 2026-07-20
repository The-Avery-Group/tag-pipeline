/**
 * Teams notification proxy. The browser sends concise CRM payloads while this
 * Worker owns Adaptive Card presentation and the webhook secret.
 */

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

const text = (value) => String(value ?? '').trim()

function cardText(value, fallback = 'Not provided') {
  return text(value) || fallback
}

function formatDate(value) {
  const raw = text(value)
  if (!raw) return 'Not provided'
  const parsed = new Date(`${raw.slice(0, 10)}T00:00:00`)
  if (Number.isNaN(parsed.getTime())) return raw
  return new Intl.DateTimeFormat('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
  }).format(parsed)
}

function opportunityUrl(base, contractNumber) {
  const identifier = text(contractNumber)
  return identifier
    ? `${base}/tag-pipeline/opportunities/${encodeURIComponent(identifier)}`
    : `${base}/tag-pipeline/opportunities`
}

function mentionToken(recipient) {
  const name = text(recipient?.name)
  if (!name) return ''
  return text(recipient?.id) ? `<at>${name}</at>` : `@${name}`
}

function mentionEntities(recipients = []) {
  const seen = new Set()
  return recipients
    .filter((recipient) => text(recipient?.name) && text(recipient?.id))
    .filter((recipient) => {
      const key = text(recipient.id).toLowerCase()
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .map((recipient) => ({
      type: 'mention',
      text: `<at>${text(recipient.name)}</at>`,
      mentioned: { id: text(recipient.id), name: text(recipient.name) },
    }))
}

function textBlock(value, options = {}) {
  return {
    type: 'TextBlock',
    text: value,
    wrap: options.wrap ?? true,
    weight: options.weight || 'Bolder',
    size: options.size,
    isSubtle: options.isSubtle,
    spacing: options.spacing || 'Small',
  }
}

function detail(label, value) {
  return textBlock(`**${label}:** ${cardText(value)}`)
}

function action(title, url) {
  return { type: 'Action.OpenUrl', title, url }
}

function rfiRows(items) {
  if (!items.length) return []
  const column = (width, value, isHeader = false) => ({
    type: 'Column',
    width,
    items: [textBlock(value, {
      size: 'Small',
      weight: isHeader ? 'Default' : 'Bolder',
      isSubtle: isHeader,
      spacing: 'None',
    })],
  })
  const header = {
    type: 'ColumnSet',
    spacing: 'Medium',
    columns: [
      column(3, 'Title', true),
      column(2, 'Notice ID', true),
      column(1, 'Submitted', true),
    ],
  }
  const rows = items.map((item) => ({
    type: 'ColumnSet',
    separator: true,
    spacing: 'Small',
    columns: [
      column(3, cardText(item.title)),
      column(2, cardText(item.contractNumber)),
      column(1, formatDate(item.submissionDate)),
    ],
  }))
  return [header, ...rows]
}

function buildCard({ title, subtitle, icon, color = 'accent', body = [], actions = [], recipients = [], noWrapTitle = false }) {
  const entities = mentionEntities(recipients)
  const content = {
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    type: 'AdaptiveCard',
    version: '1.4',
    body: [
      {
        type: 'Container',
        style: color,
        bleed: true,
        items: [
          textBlock(`${icon ? `${icon} ` : ''}${title}`, {
            size: 'Small',
            wrap: !noWrapTitle,
            spacing: 'None',
          }),
          ...(subtitle
            ? [textBlock(subtitle, { size: 'Small', weight: 'Default', isSubtle: true, spacing: 'None' })]
            : []),
        ],
      },
      ...(body.length ? [{ type: 'Container', items: body }] : []),
      ...(actions.length
        ? [{ type: 'ActionSet', separator: true, spacing: 'Medium', actions }]
        : []),
    ],
  }

  if (entities.length) content.msteams = { entities }

  return {
    type: 'message',
    attachments: [{
      contentType: 'application/vnd.microsoft.card.adaptive',
      content,
    }],
  }
}

const APP_BASE = (env) => env.ALLOWED_ORIGIN || ''

function firstUrl(value) {
  const match = text(value).match(/https?:\/\/[^\s,|]+/i)
  return match?.[0] || ''
}

function cardForType(type, payload, env) {
  const base = APP_BASE(env)

  switch (type) {
    case 'new_opportunity':
      return buildCard({
        title: 'New opportunity added',
        subtitle: 'Pipeline update',
        icon: '✚',
        color: 'good',
        body: [
          textBlock(cardText(payload.title)),
          detail('Contract / Notice ID', payload.contractNumber),
          detail('Agency', payload.agency),
        ],
        actions: [action('View in Pipeline', opportunityUrl(base, payload.contractNumber))],
      })

    case 'phase_change':
      return buildCard({
        title: 'Opportunity phase changed',
        subtitle: 'Pipeline update',
        icon: '↗',
        color: 'accent',
        body: [
          textBlock(cardText(payload.title)),
          detail('Contract / Notice ID', payload.contractNumber),
          detail('Previous phase', payload.fromPhase),
          detail('New phase', payload.toPhase),
        ],
        actions: [action('View opportunity', opportunityUrl(base, payload.contractNumber))],
      })

    case 'task_created': {
      const opportunity = [text(payload.contractTitle), text(payload.contractNumber)].filter(Boolean).join(' · ')
      return buildCard({
        title: 'New task created',
        subtitle: 'Capture activity',
        icon: '✓',
        color: 'accent',
        recipients: [payload.assignee],
        body: [
          textBlock(cardText(payload.title)),
          ...(opportunity ? [detail('Opportunity', opportunity)] : []),
          ...(payload.assignee?.name ? [detail('Assignee', mentionToken(payload.assignee))] : []),
          detail('Due date', formatDate(payload.dueDate)),
          detail('Priority', payload.priority),
        ],
        actions: [action('Open task', `${base}/tag-pipeline/tasks`)],
      })
    }

    case 'overdue_summary':
      return buildCard({
        title: 'Overdue tasks',
        subtitle: 'Action needed',
        icon: '!',
        color: 'attention',
        recipients: payload.people?.map((person) => person.recipient) || [],
        body: (payload.people || []).map((person) => textBlock(
          `${mentionToken(person.recipient)}, you have ${person.count} overdue task${person.count === 1 ? '' : 's'}`,
        )),
        actions: [action('View and complete tasks', `${base}/tag-pipeline/tasks`)],
      })

    case 'due_soon_summary':
      return buildCard({
        title: 'Tasks due tomorrow',
        subtitle: 'Action needed',
        icon: '!',
        color: 'warning',
        recipients: payload.people?.map((person) => person.recipient) || [],
        body: (payload.people || []).map((person) => textBlock(
          `${mentionToken(person.recipient)}, you have ${person.count} task${person.count === 1 ? '' : 's'} due tomorrow`,
        )),
        actions: [action('View tasks', `${base}/tag-pipeline/tasks`)],
      })

    case 'rfi_followup': {
      const recipientText = (payload.recipients || []).map(mentionToken).filter(Boolean).join(' ')
      return buildCard({
        title: 'RFI follow-up due',
        subtitle: '21 days since submission',
        icon: '↻',
        color: 'warning',
        recipients: payload.recipients || [],
        body: [
          ...(recipientText ? [textBlock(`Hey ${recipientText}, it has been 21 days since we submitted the RFIs below.`)] : []),
          ...rfiRows(payload.items || []),
          ...(payload.remainingCount ? [textBlock(`+ ${payload.remainingCount} more`, { size: 'Small', weight: 'Default', isSubtle: true })] : []),
        ],
        actions: [action('View in Pipeline', `${base}/tag-pipeline/opportunities?tab=RFIs`)],
      })
    }

    case 'rfi_response_due': {
      const isTomorrow = Number(payload.daysUntil) <= 1
      const actions = [action('View in Pipeline', opportunityUrl(base, payload.contractNumber))]
      const samUrl = firstUrl(payload.samUrl)
      if (samUrl) actions.push(action('View on SAM.gov', samUrl))
      return buildCard({
        title: isTomorrow ? 'RFI response due tomorrow' : 'RFI response due in two days',
        subtitle: 'Response reminder',
        icon: '!',
        color: isTomorrow ? 'attention' : 'warning',
        noWrapTitle: true,
        recipients: payload.recipients || [],
        body: [
          textBlock(cardText(payload.title)),
          detail('Agency', payload.agency),
          detail('Response date', formatDate(payload.responseDate)),
        ],
        actions,
      })
    }

    default:
      return null
  }
}

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
  if (!type || !payload) return json({ error: 'Missing type or payload' }, 400)

  const card = cardForType(type, payload, env)
  if (!card) return json({ error: `Unknown notification type: ${type}` }, 400)

  try {
    const response = await fetch(env.TEAMS_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(card),
    })
    if (!response.ok) {
      console.error('[Notify] Teams webhook returned', response.status)
      return json({ ok: false, error: `Teams returned ${response.status}` }, 502)
    }
    return json({ ok: true })
  } catch (error) {
    console.error('[Notify] Fetch failed:', error)
    return json({ ok: false, error: error.message }, 502)
  }
}
