/**
 * notifyService.js
 * Sends Adaptive Card notifications to the TAG Capture Teams channel.
 */

const WEBHOOK_URL = import.meta.env.VITE_TEAMS_WEBHOOK_URL
const APP_BASE_URL = import.meta.env.VITE_APP_BASE_URL || window.location.origin

function buildCard({ title, subtitle, facts, deepLinkPath, color = 'accent' }) {
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
                { type: 'TextBlock', text: subtitle, isSubtle: true, wrap: true, spacing: 'None' },
              ],
            },
            {
              type: 'FactSet',
              facts: facts.map(([t, v]) => ({ title: t, value: String(v) })),
            },
          ],
          actions: deepLinkPath
            ? [
                {
                  type: 'Action.OpenUrl',
                  title: 'Open in Pipeline Manager',
                  url: `${APP_BASE_URL}${deepLinkPath}`,
                },
              ]
            : [],
        },
      },
    ],
  }
}

async function sendCard(card) {
  if (!WEBHOOK_URL) {
    console.warn('[Notify] VITE_TEAMS_WEBHOOK_URL not set — skipping notification')
    return
  }
  try {
    await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(card),
    })
  } catch (err) {
    console.error('[Notify] Failed to send Teams notification:', err)
  }
}

export function notifyNewOpportunity(opportunity) {
  const title = opportunity['Project Title / Description*'] || opportunity.ContractTitle || '(untitled)'
  const cn    = opportunity['Contract Number / Notice ID'] || opportunity.ContractNumber || ''
  const agency = opportunity['Agency*'] || opportunity.Agency || ''
  const phase  = opportunity['TAG Opportunity Phase'] || opportunity.Phase || ''
  const value  = opportunity['Total Contract Value ($)*'] || opportunity.Value || ''
  const owner  = opportunity['Assigned To*'] || opportunity.Owner || ''
  return sendCard(
    buildCard({
      title: '🆕 New Opportunity Added',
      subtitle: title,
      facts: [
        ['Contract #', cn],
        ['Agency', agency],
        ['Phase', phase],
        ['Value', value],
        ['Assigned To', owner],
      ],
      deepLinkPath: `/opportunities/${encodeURIComponent(cn)}`,
      color: 'good',
    })
  )
}

export function notifyPhaseChange(opportunity, fromPhase, toPhase) {
  const title = opportunity['Project Title / Description*'] || opportunity.ContractTitle || '(untitled)'
  const cn    = opportunity['Contract Number / Notice ID'] || opportunity.ContractNumber || ''
  const owner = opportunity['Assigned To*'] || opportunity.Owner || ''
  return sendCard(
    buildCard({
      title: '🔄 Opportunity Phase Changed',
      subtitle: title,
      facts: [
        ['Contract #', cn],
        ['From', fromPhase],
        ['To', toPhase],
        ['Assigned To', owner],
      ],
      deepLinkPath: `/opportunities/${encodeURIComponent(cn)}`,
      color: 'accent',
    })
  )
}

export function notifyRFIFollowUp(opportunities) {
  if (!opportunities.length) return Promise.resolve()
  const shown = opportunities.slice(0, 5)
  const extra = opportunities.length - shown.length
  return sendCard(
    buildCard({
      title: `📋 ${opportunities.length} RFI Follow-Up${opportunities.length > 1 ? 's' : ''} Due`,
      subtitle: '3 weeks since submission — follow up recommended',
      facts: [
        ...shown.map((o) => [
          o['Agency*'] || o['Contract Number / Notice ID'] || '—',
          o['Project Title / Description*'] || '—',
        ]),
        ...(extra > 0 ? [['', `…and ${extra} more`]] : []),
      ],
      deepLinkPath: `/opportunities`,
      color: 'warning',
    })
  )
}

export function notifyStaleOpportunities(opportunities) {
  if (!opportunities.length) return Promise.resolve()
  const shown = opportunities.slice(0, 5)
  const extra = opportunities.length - shown.length
  return sendCard(
    buildCard({
      title: `⚠️ ${opportunities.length} Stale Opportunit${opportunities.length > 1 ? 'ies' : 'y'}`,
      subtitle: 'No activity in the past 7 days',
      facts: [
        ...shown.map((o) => [
          o['TAG Opportunity Phase'] || '—',
          o['Project Title / Description*'] || '—',
        ]),
        ...(extra > 0 ? [['', `…and ${extra} more`]] : []),
      ],
      deepLinkPath: `/opportunities`,
      color: 'warning',
    })
  )
}

export function notifyTaskCreated(task) {
  return sendCard(
    buildCard({
      title: '✅ New Task Created',
      subtitle: task.Title,
      facts: [
        ['Contract', task.ContractTitle || task.ContractNumber],
        ['Assigned to', task.AssignedTo || '—'],
        ['Due date', task.DueDate || '—'],
        ['Priority', task.Priority || '—'],
      ],
      deepLinkPath: `/tasks`,
      color: 'good',
    })
  )
}

export function notifyOverdueSummary(tasks) {
  if (!tasks.length) return Promise.resolve()
  const shown = tasks.slice(0, 5)
  const extra = tasks.length - shown.length
  return sendCard(
    buildCard({
      title: `🚨 ${tasks.length} Overdue Task${tasks.length > 1 ? 's' : ''}`,
      subtitle: extra > 0 ? `Showing ${shown.length} of ${tasks.length}` : `Requires immediate attention`,
      facts: [
        ...shown.map((t) => [t.ContractTitle || t.ContractNumber, `${t.Title} · Due ${t.DueDate}`]),
        ...(extra > 0 ? [['', `…and ${extra} more`]] : []),
      ],
      deepLinkPath: `/tasks`,
      color: 'attention',
    })
  )
}

export function notifyDueSoonSummary(tasks) {
  if (!tasks.length) return Promise.resolve()
  const shown = tasks.slice(0, 5)
  const extra = tasks.length - shown.length
  return sendCard(
    buildCard({
      title: `⏰ ${tasks.length} Task${tasks.length > 1 ? 's' : ''} Due Tomorrow`,
      subtitle: extra > 0 ? `Showing ${shown.length} of ${tasks.length}` : `Due tomorrow`,
      facts: [
        ...shown.map((t) => [t.ContractTitle || t.ContractNumber, `${t.Title} · ${t.AssignedTo || 'Unassigned'}`]),
        ...(extra > 0 ? [['', `…and ${extra} more`]] : []),
      ],
      deepLinkPath: `/tasks`,
      color: 'warning',
    })
  )
}
