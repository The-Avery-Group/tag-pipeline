/**
 * notifyService.js
 * Sends notifications via the Cloudflare Worker proxy.
 * The Worker holds the Teams webhook URL as a secret — it never touches the frontend.
 *
 * All functions send a { type, payload } body to POST /notify on the Worker.
 */

const WORKER_URL = import.meta.env.VITE_API_BASE_URL

async function sendNotification(type, payload) {
  if (!WORKER_URL) {
    console.warn('[Notify] VITE_API_BASE_URL not set — skipping notification')
    return
  }
  try {
    await fetch(`${WORKER_URL}/notify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, payload }),
    })
  } catch (err) {
    console.error('[Notify] Failed to send notification:', err)
  }
}

export function notifyNewOpportunity(opportunity) {
  return sendNotification('new_opportunity', {
    title:          opportunity['Project Title / Description*'] || '',
    contractNumber: opportunity['Contract Number / Notice ID']  || '',
    agency:         opportunity['Agency*']                      || '',
    phase:          opportunity['TAG Opportunity Phase']        || '',
    value:          opportunity['Total Contract Value ($)*']    || '',
    assignedTo:     opportunity['Assigned To*']                 || '',
  })
}

export function notifyPhaseChange(opportunity, fromPhase, toPhase) {
  return sendNotification('phase_change', {
    title:          opportunity['Project Title / Description*'] || '',
    contractNumber: opportunity['Contract Number / Notice ID']  || '',
    assignedTo:     opportunity['Assigned To*']                 || '',
    fromPhase,
    toPhase,
  })
}

export function notifyTaskCreated(task) {
  return sendNotification('task_created', {
    title:          task.Title          || '',
    contractNumber: task.ContractNumber || '',
    contractTitle:  task.ContractTitle  || '',
    assignedTo:     task.AssignedTo     || '',
    dueDate:        task.DueDate        || '',
    priority:       task.Priority       || '',
  })
}

export function notifyOverdueSummary(tasks) {
  if (!tasks.length) return Promise.resolve()
  const shown = tasks.slice(0, 5)
  return sendNotification('overdue_summary', {
    count: tasks.length,
    items: shown.map((t) => ({
      title:         t.Title          || '',
      contractNumber:t.ContractNumber || '',
      contractTitle: t.ContractTitle  || '',
      assignedTo:    t.AssignedTo     || '',
      dueDate:       t.DueDate        || '',
    })),
  })
}

export function notifyDueSoonSummary(tasks) {
  if (!tasks.length) return Promise.resolve()
  const shown = tasks.slice(0, 5)
  return sendNotification('due_soon_summary', {
    count: tasks.length,
    items: shown.map((t) => ({
      title:         t.Title          || '',
      contractNumber:t.ContractNumber || '',
      contractTitle: t.ContractTitle  || '',
      assignedTo:    t.AssignedTo     || '',
      dueDate:       t.DueDate        || '',
    })),
  })
}

export function notifyRFIFollowUp(opportunities) {
  if (!opportunities.length) return Promise.resolve()
  const shown = opportunities.slice(0, 5)
  return sendNotification('rfi_followup', {
    count: opportunities.length,
    items: shown.map((o) => ({
      title:          o['Project Title / Description*'] || '',
      contractNumber: o['Contract Number / Notice ID']  || '',
      agency:         o['Agency*']                      || '',
    })),
  })
}

export function notifyStaleOpportunities(opportunities) {
  if (!opportunities.length) return Promise.resolve()
  const shown = opportunities.slice(0, 5)
  return sendNotification('stale_opportunities', {
    count: opportunities.length,
    items: shown.map((o) => ({
      title:          o['Project Title / Description*'] || '',
      contractNumber: o['Contract Number / Notice ID']  || '',
      phase:          o['TAG Opportunity Phase']        || '',
    })),
  })
}
