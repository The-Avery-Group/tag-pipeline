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

export function notifyTaskDueSoon(task) {
  return sendCard(
    buildCard({
      title: '⏰ Task Due Tomorrow',
      subtitle: task.Title,
      facts: [
        ['Contract', task.ContractTitle],
        ['Contract #', task.ContractNumber],
        ['Assigned to', task.AssignedTo],
        ['Due date', task.DueDate],
        ['Priority', task.Priority],
      ],
      deepLinkPath: `/tasks`,
      color: 'warning',
    })
  )
}

export function notifyTaskOverdue(task) {
  return sendCard(
    buildCard({
      title: '🚨 Task Overdue',
      subtitle: task.Title,
      facts: [
        ['Contract', task.ContractTitle],
        ['Contract #', task.ContractNumber],
        ['Assigned to', task.AssignedTo],
        ['Was due', task.DueDate],
        ['Priority', task.Priority],
      ],
      deepLinkPath: `/tasks`,
      color: 'attention',
    })
  )
}
