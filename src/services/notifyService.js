/**
 * Sends compact Teams notification payloads through the Worker proxy.
 * The Worker owns the card layout and webhook secret. This module only adds
 * workbook context, including optional Teams mention identities.
 */

import { ASSIGNEE_VALUES, getNotificationRecipients, getValidationLists } from '@/services/graphService'
import { WORKER_URL, workerFetch } from '@/services/workerClient'

const text = (value) => String(value ?? '').trim()
const localCalendarDay = () => {
  const date = new Date()
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

async function sendNotification(type, payload) {
  if (!WORKER_URL) {
    console.warn('[Notify] VITE_API_BASE_URL not set, skipping notification')
    return false
  }

  try {
    const response = await workerFetch('/notify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, payload }),
    })
    if (!response.ok) throw new Error(`Notification proxy returned ${response.status}`)
    return true
  } catch (error) {
    console.error('[Notify] Failed to send notification:', error)
    return false
  }
}

// Scheduled, app-only notifications are the primary path once the Worker is
// configured. A failed or temporarily unreadable run must not hand ownership
// back to every signed-in browser, because each login would then attempt the
// same reminder cycle. The browser fallback is used only when the Worker
// explicitly reports that app-only delivery is not configured.
export async function scheduledNotificationsArePrimary() {
  if (!WORKER_URL) return false
  try {
    const response = await workerFetch('/integrations/status', { cache: 'no-store' })
    // A transient status/auth/network failure is not proof that app-only
    // delivery is unavailable. Fail closed to avoid duplicate Teams cards.
    if (!response.ok) return true
    const payload = await response.json()
    const state = payload?.notifications
    return state?.appOnlyAvailable !== false
  } catch {
    return true
  }
}

function isMentionEnabled(value) {
  return ['yes', 'true', 'enabled', '1'].includes(text(value).toLowerCase())
}

async function recipientDirectory() {
  const rows = await getNotificationRecipients()
  return new Map(rows
    .map((row) => {
      const assignee = text(row['Pipeline Assignee'])
      if (!assignee) return null
      return [assignee.toLowerCase(), {
        name: text(row['Teams Display Name']) || assignee,
        id: isMentionEnabled(row['Mention Enabled'])
          ? text(row['Teams UPN / Entra Object ID'])
          : '',
      }]
    })
    .filter(Boolean))
}

async function resolveRecipients(assignees) {
  const directory = await recipientDirectory()
  const seen = new Set()

  return assignees
    .map((assignee) => text(assignee))
    .filter(Boolean)
    .map((assignee) => directory.get(assignee.toLowerCase()) || { name: assignee, id: '' })
    .filter((recipient) => {
      const key = `${recipient.name.toLowerCase()}|${recipient.id.toLowerCase()}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
}

async function resolveAllAssigneeRecipients() {
  try {
    const lists = await getValidationLists()
    const assignees = lists.Assignee?.length ? lists.Assignee : ASSIGNEE_VALUES
    return resolveRecipients(assignees)
  } catch (error) {
    console.warn('[Notify] Could not read the Assignee dropdown; using the default RFI notification recipients.', error.message)
    return resolveRecipients(ASSIGNEE_VALUES)
  }
}

function groupTasksByAssignee(tasks) {
  const groups = new Map()
  tasks.forEach((task) => {
    const assignee = text(task.AssignedTo) || 'Unassigned'
    groups.set(assignee, (groups.get(assignee) || 0) + 1)
  })
  return [...groups.entries()].map(([assignee, count]) => ({ assignee, count }))
}

export function notifyNewOpportunity(opportunity) {
  return sendNotification('new_opportunity', {
    title: text(opportunity['Project Title / Description*']),
    contractNumber: text(opportunity['Contract Number / Notice ID']),
    agency: text(opportunity['Agency*']),
  })
}

export async function notifyPhaseChange(opportunity, fromPhase, toPhase) {
  return sendNotification('phase_change', {
    title: text(opportunity['Project Title / Description*']),
    contractNumber: text(opportunity['Contract Number / Notice ID']),
    fromPhase: text(fromPhase),
    toPhase: text(toPhase),
  })
}

export async function notifyTaskCreated(task) {
  const [assignee] = await resolveRecipients([task.AssignedTo])
  return sendNotification('task_created', {
    title: text(task.Title),
    contractNumber: text(task.ContractNumber),
    contractTitle: text(task.ContractTitle),
    assignee: assignee || null,
    dueDate: text(task.DueDate),
    priority: text(task.Priority),
  })
}

async function notifyTaskSummary(type, tasks) {
  if (!tasks.length) return false
  const groups = groupTasksByAssignee(tasks)
  const directory = await recipientDirectory()

  return sendNotification(type, {
    summaryDate: localCalendarDay(),
    people: groups.map((group) => ({
      ...group,
      recipient: directory.get(group.assignee.toLowerCase()) || { name: group.assignee, id: '' },
    })),
  })
}

export function notifyOverdueSummary(tasks) {
  return notifyTaskSummary('overdue_summary', tasks)
}

export function notifyDueSoonSummary(tasks) {
  return notifyTaskSummary('due_soon_summary', tasks)
}

export async function notifyRFIFollowUp(opportunities) {
  if (!opportunities.length) return false
  const recipients = await resolveAllAssigneeRecipients()
  return sendNotification('rfi_followup', {
    recipients,
    filterIds: opportunities
      .map((opportunity) => text(opportunity['Contract Number / Notice ID']))
      .filter(Boolean),
    items: opportunities.slice(0, 5).map((opportunity) => ({
      title: text(opportunity['Project Title / Description*']),
      contractNumber: text(opportunity['Contract Number / Notice ID']),
      submissionDate: text(opportunity['Submission Date (Response Date)*']),
      noticeType: text(opportunity['Notice Type']),
    })),
    remainingCount: Math.max(0, opportunities.length - 5),
  })
}

export async function notifyRFIResponseReminder(opportunity, daysUntil) {
  const recipients = await resolveAllAssigneeRecipients()
  return sendNotification('rfi_response_due', {
    title: text(opportunity['Project Title / Description*']),
    contractNumber: text(opportunity['Contract Number / Notice ID']),
    agency: text(opportunity['Agency*']),
    responseDate: text(opportunity['Submission Date (Response Date)*']),
    samUrl: text(opportunity['Other Links*']),
    daysUntil,
    noticeType: text(opportunity['Notice Type']),
    recipients,
  })
}

export async function notifyStaleContacts(contacts) {
  if (!contacts.length) return false
  const recipients = await resolveAllAssigneeRecipients()
  return sendNotification('contact_followup', {
    recipients,
    // Contact follow-up cards intentionally handle a maximum of five people
    // per run. Do not send or reserve the remainder of the stale-contact set.
    items: contacts.slice(0, 5).map((contact) => ({
      contactId: text(contact.ContactID),
      name: text(contact.Name),
      agency: text(contact.Agency),
      lastInteraction: text(contact.lastInteraction),
    })),
  })
}
