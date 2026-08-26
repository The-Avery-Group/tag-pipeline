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

export function taskSummaryDedupeKey(type, payload) {
  if (!['overdue_summary', 'due_soon_summary'].includes(type)) return ''
  const date = text(payload?.summaryDate)
  // The browser provides its local calendar day so the card follows the
  // same day boundary as the signed-in users who trigger the check.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return ''
  const category = type === 'overdue_summary' ? 'overdue' : 'duesoon'
  return `teams_notification:${category}:${date}`
}

async function reserveDedupeKey(env, key, expirationTtl = 172800) {
  if (!key || !env.CACHE) return true
  try {
    if (await env.CACHE.get(key)) return false
    // One small shared write, retained long enough to cover delayed browser
    // sessions. All later sign-ins only read this key and do not post a card.
    await env.CACHE.put(key, 'sent', { expirationTtl })
    return true
  } catch (error) {
    // Notification delivery should remain available if KV has a transient
    // problem. The existing workbook log remains a second, client-side gate.
    console.warn('[Notify] Could not reserve summary notification:', error.message)
    return true
  }
}

async function releaseDedupeKey(env, key) {
  if (!key || !env.CACHE) return
  try {
    await env.CACHE.delete(key)
  } catch (error) {
    console.warn('[Notify] Could not release summary notification:', error.message)
  }
}

function contactFollowUpDedupeKey(contact) {
  const id = text(contact?.contactId)
  const lastInteraction = text(contact?.lastInteraction)
  if (!id || !lastInteraction) return ''
  return `teams_notification:contact_followup:${encodeURIComponent(id)}:${lastInteraction}`
}

async function reserveContactFollowUps(env, payload) {
  const eligible = []
  const reservedKeys = []
  for (const contact of Array.isArray(payload?.items) ? payload.items : []) {
    const key = contactFollowUpDedupeKey(contact)
    if (!key || await reserveDedupeKey(env, key, 14 * 24 * 60 * 60)) {
      eligible.push(contact)
      if (key) reservedKeys.push(key)
    }
  }
  return {
    payload: {
      ...payload,
      items: eligible.slice(0, 5),
      remainingCount: Math.max(0, eligible.length - 5),
    },
    reservedKeys,
  }
}

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

function rfiFollowUpUrl(base, identifiers) {
  const ids = (identifiers || []).map(text).filter(Boolean)
  const params = new URLSearchParams({ tab: 'Responses' })
  if (ids.length) params.set('rfiFollowUps', JSON.stringify(ids))
  return `${base}/tag-pipeline/opportunities?${params.toString()}`
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

function uniqueRecipients(recipients = []) {
  const seen = new Set()
  return recipients.filter((recipient) => {
    const id = text(recipient?.id).toLowerCase()
    const name = text(recipient?.name).toLowerCase()
    if (!name) return false
    const key = id ? `id:${id}` : `name:${name}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function uniquePeople(people = []) {
  const grouped = new Map()
  people.forEach((person) => {
    const recipient = person?.recipient || {}
    const id = text(recipient.id).toLowerCase()
    const name = text(recipient.name || person?.assignee).toLowerCase()
    if (!name) return
    const key = id ? `id:${id}` : `name:${name}`
    const existing = grouped.get(key)
    if (existing) {
      existing.count += Number(person.count) || 0
      return
    }
    grouped.set(key, {
      ...person,
      count: Number(person.count) || 0,
      recipient: {
        name: text(recipient.name || person?.assignee),
        id: text(recipient.id),
      },
    })
  })
  return [...grouped.values()]
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

function marketResearchLabel(items = [], fallback = '') {
  const types = new Set(items.map((item) => String(item?.noticeType || '').trim().toUpperCase()).filter(Boolean))
  if (!types.size && fallback) types.add(String(fallback).trim().toUpperCase())
  if (!types.size) return 'RFI'
  if (types.size === 1 && types.has('MRAS')) return 'MRAS'
  if (types.size === 1 && types.has('RFI')) return 'RFI'
  return 'RFI and MRAS'
}

function contactRows(items) {
  return items.map((item) => textBlock(
    `**${cardText(item.name)}**${item.agency ? ` · ${cardText(item.agency)}` : ''}\nLast interaction: ${formatDate(item.lastInteraction)}`,
    { size: 'Small' },
  ))
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

export function cardForType(type, payload, env) {
  const base = APP_BASE(env)

  switch (type) {
    case 'new_opportunity':
      return buildCard({
        title: 'Opportunity added to pipeline',
        subtitle: 'Pipeline update',
        icon: '✚',
        color: 'good',
        body: [
          textBlock(cardText(payload.title)),
          detail('Contract or notice ID', payload.contractNumber),
          detail('Agency', payload.agency),
        ],
        actions: [action('View opportunity', opportunityUrl(base, payload.contractNumber))],
      })

    case 'phase_change':
      return buildCard({
        title: 'Opportunity phase changed',
        subtitle: 'Pipeline update',
        icon: '↗',
        color: 'accent',
        body: [
          textBlock(cardText(payload.title)),
          detail('Contract or notice ID', payload.contractNumber),
          detail('Previous phase', payload.fromPhase),
          detail('New phase', payload.toPhase),
        ],
        actions: [action('View opportunity', opportunityUrl(base, payload.contractNumber))],
      })

    case 'award_notice':
      return buildCard({
        title: 'Possible award notice found',
        subtitle: 'Pending Award review',
        icon: '◆',
        color: 'warning',
        body: [
          textBlock(cardText(payload.title)),
          detail('Solicitation', payload.solicitationNumber),
          detail('Awardee', payload.awardeeName),
          detail('Award number', payload.awardNumber),
          detail('Award date', formatDate(payload.awardDate)),
          detail('Award amount', payload.awardAmount),
          detail('Match evidence', payload.matchEvidence),
        ],
        actions: [
          action('Review opportunity', opportunityUrl(base, payload.contractNumber)),
          ...(payload.samLink ? [action('Open SAM notice', payload.samLink)] : []),
        ],
      })

    case 'task_created': {
      const opportunity = [text(payload.contractTitle), text(payload.contractNumber)].filter(Boolean).join(' · ')
      return buildCard({
        title: 'Task created',
        subtitle: 'Capture activity',
        icon: '✓',
        color: 'accent',
        recipients: [payload.assignee],
        body: [
          ...(payload.assignee?.name ? [textBlock(`A new task has been assigned to ${mentionToken(payload.assignee)}.`)] : []),
          textBlock(cardText(payload.title)),
          ...(opportunity ? [detail('Opportunity', opportunity)] : []),
          detail('Due date', formatDate(payload.dueDate)),
          detail('Priority', payload.priority),
        ],
        actions: [action('View tasks', `${base}/tag-pipeline/tasks`)],
      })
    }

    case 'overdue_summary': {
      const people = uniquePeople(payload.people || [])
      return buildCard({
        title: 'Overdue tasks',
        subtitle: 'Action needed',
        icon: '!',
        color: 'attention',
        recipients: people.map((person) => person.recipient),
        body: people.map((person) => textBlock(
          `${mentionToken(person.recipient)}, you have ${person.count} overdue task${person.count === 1 ? '' : 's'}. Please review and complete them.`,
        )),
        actions: [action('View and complete tasks', `${base}/tag-pipeline/tasks`)],
      })
    }

    case 'due_soon_summary': {
      const people = uniquePeople(payload.people || [])
      return buildCard({
        title: 'Tasks due tomorrow',
        subtitle: 'Action needed',
        icon: '!',
        color: 'warning',
        recipients: people.map((person) => person.recipient),
        body: people.map((person) => textBlock(
          `${mentionToken(person.recipient)}, you have ${person.count} task${person.count === 1 ? '' : 's'} due tomorrow. Please review them today.`,
        )),
        actions: [action('View tasks', `${base}/tag-pipeline/tasks`)],
      })
    }

    case 'rfi_followup': {
      const recipients = uniqueRecipients(payload.recipients || [])
      const recipientText = recipients.map(mentionToken).filter(Boolean).join(' ')
      const workflowLabel = marketResearchLabel(payload.items)
      return buildCard({
        title: `${workflowLabel} follow-up email due`,
        subtitle: '21 days since submission',
        icon: '✉',
        color: 'warning',
        recipients,
        body: [
          textBlock(`${recipientText ? `Hello ${recipientText}, the` : 'The'} opportunities below are due for follow-up. Review their email drafts in TAG CRM.`),
          ...rfiRows(payload.items || []),
          ...(payload.remainingCount ? [textBlock(`+ ${payload.remainingCount} more`, { size: 'Small', weight: 'Default', isSubtle: true })] : []),
          textBlock('Nothing is sent automatically.', { size: 'Small', weight: 'Default', isSubtle: true }),
        ],
        actions: [action('Review follow-up drafts', rfiFollowUpUrl(base, payload.filterIds))],
      })
    }

    case 'rfi_response_due': {
      const isTomorrow = Number(payload.daysUntil) <= 1
      const actions = [action('View opportunity', opportunityUrl(base, payload.contractNumber))]
      const samUrl = firstUrl(payload.samUrl)
      const recipients = uniqueRecipients(payload.recipients || [])
      const recipientText = recipients.map(mentionToken).filter(Boolean).join(' ')
      const workflowLabel = marketResearchLabel([], payload.noticeType)
      if (samUrl) actions.push(action('View on SAM.gov', samUrl))
      return buildCard({
        title: isTomorrow ? `${workflowLabel} response due tomorrow` : `${workflowLabel} response due in two days`,
        subtitle: 'Response reminder',
        icon: '!',
        color: isTomorrow ? 'attention' : 'warning',
        noWrapTitle: true,
        recipients,
        body: [
          ...(recipientText ? [textBlock(`Hello ${recipientText}, please note that this ${workflowLabel} response is due ${isTomorrow ? 'tomorrow' : 'in two days'}.`)] : []),
          textBlock(cardText(payload.title)),
          detail('Agency', payload.agency),
          detail('Response date', formatDate(payload.responseDate)),
        ],
        actions,
      })
    }

    case 'contact_followup': {
      const recipients = uniqueRecipients(payload.recipients || [])
      const recipientText = recipients.map(mentionToken).filter(Boolean).join(' ')
      return buildCard({
        title: 'Contact follow-up due',
        subtitle: 'No interaction in 30 days',
        icon: '◷',
        color: 'warning',
        recipients,
        body: [
          ...(recipientText ? [textBlock(`Hello ${recipientText}, please review these contacts.`)] : []),
          ...contactRows(payload.items || []),
          ...(payload.remainingCount ? [textBlock(`+ ${payload.remainingCount} more`, { size: 'Small', weight: 'Default', isSubtle: true })] : []),
        ],
        actions: [action('View contacts', `${base}/tag-pipeline/contacts`)],
      })
    }

    default:
      return null
  }
}

export async function sendTeamsNotification(env, type, payload) {
  if (!env.TEAMS_WEBHOOK_URL) {
    console.warn('[Notify] TEAMS_WEBHOOK_URL secret not set')
    return { ok: false, error: 'Webhook not configured' }
  }
  const card = cardForType(type, payload, env)
  if (!card) return { ok: false, error: `Unknown notification type: ${type}` }

  try {
    const response = await fetch(env.TEAMS_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(card),
    })
    if (!response.ok) {
      console.error('[Notify] Teams webhook returned', response.status)
      return { ok: false, error: `Teams returned ${response.status}` }
    }
    return { ok: true }
  } catch (error) {
    console.error('[Notify] Fetch failed:', error)
    return { ok: false, error: error.message }
  }
}

export async function handleNotify(req, env) {
  let body
  try {
    body = await req.json()
  } catch {
    return json({ error: 'Invalid JSON body' }, 400)
  }

  const { type } = body
  let { payload } = body
  if (!type || !payload) return json({ error: 'Missing type or payload' }, 400)

  const reservedKeys = []
  const dedupeKey = taskSummaryDedupeKey(type, payload)
  if (!(await reserveDedupeKey(env, dedupeKey))) return json({ ok: true, deduplicated: true })
  if (dedupeKey) reservedKeys.push(dedupeKey)

  if (type === 'contact_followup') {
    const reservation = await reserveContactFollowUps(env, payload)
    payload = reservation.payload
    reservedKeys.push(...reservation.reservedKeys)
    if (payload.items.length === 0) return json({ ok: true, deduplicated: true })
  }

  const result = await sendTeamsNotification(env, type, payload)
  if (!result.ok) {
    await Promise.all(reservedKeys.map((key) => releaseDedupeKey(env, key)))
    return json(result, result.error === 'Webhook not configured' ? 503 : 502)
  }
  return json(result)
}
