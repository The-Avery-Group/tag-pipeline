/**
 * Scheduled Teams reminders.
 *
 * This is the app-only primary path. The browser reminder hook remains a
 * fallback when app-only Graph access is unavailable, so an Azure or Worker
 * configuration issue does not completely silence the team.
 */

import { sendTeamsNotification } from './notify.js'
import { getAppOnlyGraphToken as appOnlyToken } from '../lib/graph.js'
import { putAutomationRun } from '../lib/automationHealth.js'

const DRIVE_ID = 'b!DvVPmhUD7k2Va33gQGDdB3rFM6P2zkVNvlMvEl7p-levrO3tXf_USZvsR_Sr0bTe'
const NOTIFICATION_LOG_TABLE = 'DataValidationTable'
const PIPELINE_TABLE = 'PipelineTable'
const TASKS_TABLE = 'TasksTable'
const CONTACTS_TABLE = 'ContactsTable'
const INTERACTIONS_TABLE = 'ContactInteractionsTable'
const RECIPIENTS_TABLE = 'NotificationRecipientsTable'
const RUN_KEY = 'scheduled_notifications:last_run'

const clean = (value) => String(value ?? '').trim()
const dateKey = (date = new Date()) => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Africa/Lagos', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date)
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  return `${value.year}-${value.month}-${value.day}`
}

function weekdayInNigeria(date = new Date()) {
  const weekday = new Intl.DateTimeFormat('en-US', { timeZone: 'Africa/Lagos', weekday: 'short' }).format(date)
  return !['Sat', 'Sun'].includes(weekday)
}

function normalizedDate(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const date = new Date((value - 25569) * 86400000)
    return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 10)
  }
  const match = clean(value).match(/^(\d{4})-(\d{2})-(\d{2})/)
  return match ? `${match[1]}-${match[2]}-${match[3]}` : ''
}

function parseDate(value) {
  const match = normalizedDate(value).match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (!match) return null
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])))
  return Number.isNaN(date.getTime()) ? null : date
}

function daysFromToday(value, today) {
  const date = parseDate(value)
  const current = parseDate(today)
  if (!date || !current) return null
  return Math.round((date.getTime() - current.getTime()) / 86400000)
}

function daysAgo(value, today) {
  const remaining = daysFromToday(value, today)
  return remaining === null ? null : -remaining
}

function isMentionEnabled(value) {
  return ['yes', 'true', 'enabled', '1'].includes(clean(value).toLowerCase())
}

function workbookBase(env) {
  return `https://graph.microsoft.com/v1.0/drives/${DRIVE_ID}/items/${env.WORKBOOK_ID}/workbook`
}

async function graph(env, token, path, options = {}) {
  const response = await fetch(`${workbookBase(env)}${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(options.headers || {}) },
  })
  if (response.status === 204) return null
  const raw = await response.text()
  let body = null
  if (raw) {
    try { body = JSON.parse(raw) } catch {
      throw new Error(response.ok ? 'Microsoft Graph returned invalid JSON' : `Microsoft Graph error ${response.status}: ${raw.slice(0, 160)}`)
    }
  }
  if (!response.ok) throw new Error(body?.error?.message || `Microsoft Graph error ${response.status}`)
  return body
}

async function table(env, token, name, optional = false) {
  try {
    const readRows = async () => {
      if (name !== CONTACTS_TABLE) return graph(env, token, `/tables/${name}/rows`)
      const value = []
      for (let skip = 0; ; skip += 250) {
        const page = await graph(env, token, `/tables/${name}/rows?$top=250&$skip=${skip}`)
        const pageRows = page.value || []
        value.push(...pageRows)
        if (pageRows.length < 250) return { value }
      }
    }
    const [rows, columns] = await Promise.all([
      readRows(),
      graph(env, token, `/tables/${name}/columns`),
    ])
    const headers = (columns.value || []).map((item) => item.name)
    return {
      name,
      headers,
      rows: (rows.value || []).map((row) => ({
        _rowIndex: row.index,
        _values: [...(row.values?.[0] || [])],
        ...Object.fromEntries(headers.map((header, index) => [header, row.values?.[0]?.[index] ?? ''])),
      })),
    }
  } catch (error) {
    if (optional && /not found|itemNotFound|404/i.test(error.message)) return { name, headers: [], rows: [] }
    throw error
  }
}

async function updateTableRow(env, token, record, patch) {
  const values = record._values.map((value, index) => patch[record.headers?.[index]] ?? value)
  // table() records do not retain headers, so callers attach them once.
  await graph(env, token, `/tables/${record._tableName}/rows/itemAt(index=${record._rowIndex})`, {
    method: 'PATCH', body: JSON.stringify({ values: [values] }),
  })
}

function attachTableMeta(data) {
  data.rows.forEach((row) => { row.headers = data.headers; row._tableName = data.name })
  return data
}

async function writeLog(env, token, data, key, value) {
  if (!data.headers.includes('Key') || !data.headers.includes('LastSent')) return false
  const existing = data.rows.find((row) => clean(row.Key) === key)
  const blank = data.rows.find((row) => !clean(row.Key))
  if (existing || blank) {
    const record = existing || blank
    await updateTableRow(env, token, record, { Key: key, LastSent: value })
    record.Key = key
    record.LastSent = value
    return true
  }
  const values = data.headers.map((header) => header === 'Key' ? key : header === 'LastSent' ? value : '')
  await graph(env, token, `/tables/${data.name}/rows/add`, { method: 'POST', body: JSON.stringify({ values: [values] }) })
  data.rows.push({ Key: key, LastSent: value, _values: values, _rowIndex: -1, headers: data.headers, _tableName: data.name })
  return true
}

const recipientLookupKey = (value) => clean(value)
  .normalize('NFKC')
  .replace(/\s+/g, ' ')
  .toLowerCase()

function rowField(row, names) {
  const entries = Object.entries(row || {})
  for (const name of names) {
    const exact = row?.[name]
    if (exact !== undefined) return exact
    const normalizedName = recipientLookupKey(name)
    const matched = entries.find(([header]) => recipientLookupKey(header) === normalizedName)
    if (matched) return matched[1]
  }
  return ''
}

export function resolveNotificationRecipients(directory, assignees) {
  const seen = new Set()
  return assignees.map(clean).filter(Boolean).map((assignee) => directory.get(recipientLookupKey(assignee)) || { name: assignee, id: '' })
    .filter((recipient) => {
      // Teams requires one matching entity per <at> token. If aliases resolve
      // to the same UPN/object ID, keep only one recipient so the card text and
      // msteams.entities array cannot drift out of alignment.
      const id = recipientLookupKey(recipient.id)
      const key = id ? `id:${id}` : `name:${recipientLookupKey(recipient.name)}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
}

export function buildNotificationRecipientDirectory(rows) {
  const directory = new Map()
  rows.forEach((row) => {
    const assignee = clean(rowField(row, ['Pipeline Assignee', 'Assignee']))
    const displayName = clean(rowField(row, ['Teams Display Name', 'Display Name', 'Full Name'])) || assignee
    const identity = clean(rowField(row, [
      'Teams UPN / Entra Object ID',
      'Teams UPN',
      'Entra Object ID',
      'UPN',
      'Email',
    ]))
    const enabled = isMentionEnabled(rowField(row, ['Mention Enabled', 'Mentions Enabled']))
    if (!assignee) return

    const recipient = { name: displayName, id: enabled ? identity : '' }
    directory.set(recipientLookupKey(assignee), recipient)
    // Also accept the display name used by task and validation values. This
    // makes the scheduled path resilient when one list uses the short name
    // and another uses the person's full Teams display name.
    if (displayName) directory.set(recipientLookupKey(displayName), recipient)
  })
  return directory
}

function allAssignees(validationRows) {
  const configured = validationRows.map((row) => clean(row.Assignee)).filter(Boolean)
  return configured.length ? configured : ['Breanna', 'Ayomide', 'AO']
}

function responseReminderKey(opportunity, days) {
  return `rfi_response_${days}_${encodeURIComponent(clean(opportunity['Contract Number / Notice ID'] || opportunity._rowIndex))}`
}

function contactLogKey(contact) {
  return `contact_stale_${encodeURIComponent(clean(contact.ContactID || contact.Email || contact.Name || contact._rowIndex))}`
}

function logMap(rows) {
  return Object.fromEntries(rows.filter((row) => clean(row.Key)).map((row) => [clean(row.Key), clean(row.LastSent)]))
}

export function notificationsAppOnlyAvailable(env) {
  return Boolean(env.TEAMS_WEBHOOK_URL && env.WORKBOOK_ID && env.MS_TENANT_ID && env.MS_CLIENT_ID && env.MS_CLIENT_SECRET)
}

export async function getNotificationMonitorStatus(env) {
  return {
    appOnlyAvailable: notificationsAppOnlyAvailable(env),
    lastRun: await env.CACHE?.get(RUN_KEY, 'json') || null,
  }
}

export async function runScheduledNotifications(env) {
  const startedAt = new Date().toISOString()
  if (!notificationsAppOnlyAvailable(env)) {
    const message = 'App-only notifications are not configured; browser fallback remains active.'
    console.warn(JSON.stringify({ event: 'scheduled_notifications', status: 'skipped', message, startedAt }))
    return { ok: false, skipped: true, message }
  }

  try {
    const token = await appOnlyToken(env)
    const [pipelineData, tasksData, validationData, recipientsData, contactsData, interactionsData] = await Promise.all([
      table(env, token, PIPELINE_TABLE), table(env, token, TASKS_TABLE), table(env, token, NOTIFICATION_LOG_TABLE),
      table(env, token, RECIPIENTS_TABLE, true), table(env, token, CONTACTS_TABLE, true), table(env, token, INTERACTIONS_TABLE, true),
    ])
    const pipeline = attachTableMeta(pipelineData)
    const tasks = attachTableMeta(tasksData)
    const validation = attachTableMeta(validationData)
    const contacts = attachTableMeta(contactsData)
    const log = logMap(validation.rows)
    const today = dateKey()
    const isWeekday = weekdayInNigeria()
    const directory = buildNotificationRecipientDirectory(recipientsData.rows)
    const configuredAssignees = allAssignees(validation.rows)
    const everyone = resolveNotificationRecipients(directory, configuredAssignees)
    const recipientStatus = {
      configuredRows: recipientsData.rows.length,
      directoryEntries: directory.size,
      scheduledRecipients: everyone.length,
      mentionCapable: everyone.filter((recipient) => clean(recipient.id)).length,
      missingMappings: everyone
        .filter((recipient) => !clean(recipient.id))
        .map((recipient) => clean(recipient.name))
        .filter(Boolean),
    }
    if (recipientStatus.mentionCapable === 0 && recipientStatus.scheduledRecipients > 0) {
      console.warn(JSON.stringify({
        event: 'scheduled_notification_recipients',
        status: 'no_mentions',
        ...recipientStatus,
      }))
    }
    const sent = []

    const sendAndLog = async (type, payload, key) => {
      if (key && log[key] === today) return false
      const result = await sendTeamsNotification(env, type, payload)
      if (!result.ok) throw new Error(`${type}: ${result.error}`)
      if (key) {
        await writeLog(env, token, validation, key, today)
        log[key] = today
      }
      sent.push(type)
      return true
    }

    // Response-date reminders are the one scheduled category intentionally
    // allowed on weekends. All other reminders wait until Monday.
    for (const opportunity of pipeline.rows) {
      const isNewRfi = clean(opportunity['TAG Opportunity Phase']) === 'Identified' && clean(opportunity['Opportunity Outlook']) === 'New'
      const remaining = daysFromToday(opportunity['Submission Date (Response Date)*'], today)
      if (!isNewRfi || ![1, 2].includes(remaining)) continue
      await sendAndLog('rfi_response_due', {
        title: clean(opportunity['Project Title / Description*']),
        contractNumber: clean(opportunity['Contract Number / Notice ID']),
        agency: clean(opportunity['Agency*']),
        responseDate: normalizedDate(opportunity['Submission Date (Response Date)*']),
        samUrl: clean(opportunity['Other Links*']), daysUntil: remaining, recipients: everyone,
      }, responseReminderKey(opportunity, remaining))
    }

    if (isWeekday) {
      const overdueGroups = new Map()
      const dueSoonGroups = new Map()
      tasks.rows.forEach((task) => {
        if (clean(task.Status) === 'Done') return
        const assignee = clean(task.AssignedTo) || 'Unassigned'
        const remaining = daysFromToday(task.DueDate, today)
        if (remaining !== null && remaining < 0) overdueGroups.set(assignee, (overdueGroups.get(assignee) || 0) + 1)
        if (remaining === 1) dueSoonGroups.set(assignee, (dueSoonGroups.get(assignee) || 0) + 1)
      })
      const groupPayload = (groups) => [...groups.entries()].map(([assignee, count]) => ({
        assignee, count, recipient: resolveNotificationRecipients(directory, [assignee])[0] || { name: assignee, id: '' },
      }))
      if (overdueGroups.size) await sendAndLog('overdue_summary', { people: groupPayload(overdueGroups), summaryDate: today }, 'overdue')
      if (dueSoonGroups.size) {
        await sendAndLog('due_soon_summary', {
          people: groupPayload(dueSoonGroups),
          summaryDate: today,
        }, 'duesoon')
      }

      const rfiDue = pipeline.rows.filter((opportunity) =>
        clean(opportunity['TAG Pipeline Activity Phase']) === 'Submitted RFI' && !clean(opportunity['RFI Notified']) &&
        (daysAgo(opportunity['Submission Date (Response Date)*'], today) ?? -1) >= 21
      )
      if (rfiDue.length) {
        const result = await sendTeamsNotification(env, 'rfi_followup', {
          recipients: everyone,
          filterIds: rfiDue.map((item) => clean(item['Contract Number / Notice ID'])).filter(Boolean),
          items: rfiDue.slice(0, 5).map((item) => ({
            title: clean(item['Project Title / Description*']), contractNumber: clean(item['Contract Number / Notice ID']),
            submissionDate: normalizedDate(item['Submission Date (Response Date)*']),
          })),
          remainingCount: Math.max(0, rfiDue.length - 5),
        })
        if (!result.ok) throw new Error(`rfi_followup: ${result.error}`)
        for (const opportunity of rfiDue) await updateTableRow(env, token, opportunity, { 'RFI Notified': today })
        sent.push('rfi_followup')
      }

      const lastInteraction = new Map()
      interactionsData.rows.forEach((interaction) => {
        const id = clean(interaction.ContactID)
        const date = normalizedDate(interaction['Interaction Date'])
        if (id && parseDate(date) && (!lastInteraction.has(id) || date > lastInteraction.get(id))) lastInteraction.set(id, date)
      })
      const staleContacts = contacts.rows.map((contact) => ({ ...contact, lastInteraction: lastInteraction.get(clean(contact.ContactID)) || '' }))
        .filter((contact) => {
          const age = daysAgo(contact.lastInteraction, today)
          const lastSent = log[contactLogKey(contact)]
          return age !== null && age >= 30 && (!lastSent || (daysAgo(lastSent, today) ?? 0) >= 14)
        }).slice(0, 5)
      if (staleContacts.length) {
        const result = await sendTeamsNotification(env, 'contact_followup', {
          recipients: everyone,
          items: staleContacts.map((contact) => ({ contactId: clean(contact.ContactID), name: clean(contact.Name), agency: clean(contact.Agency), lastInteraction: contact.lastInteraction })),
        })
        if (!result.ok) throw new Error(`contact_followup: ${result.error}`)
        for (const contact of staleContacts) await writeLog(env, token, validation, contactLogKey(contact), today)
        sent.push('contact_followup')
      }
    }

    const result = {
      ok: true,
      status: 'success',
      source: 'app-only',
      startedAt,
      completedAt: new Date().toISOString(),
      weekday: isWeekday,
      recipients: recipientStatus,
      sent,
    }
    await putAutomationRun(env, RUN_KEY, result, { expirationTtl: 60 * 60 * 24 * 14 })
    console.log(JSON.stringify({ event: 'scheduled_notifications', ...result }))
    return result
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown scheduled notification error'
    const result = { ok: false, status: 'error', source: 'app-only', message, startedAt, completedAt: new Date().toISOString() }
    await putAutomationRun(env, RUN_KEY, result, { expirationTtl: 60 * 60 * 24 * 14 })
    console.error(JSON.stringify({ event: 'scheduled_notifications', ...result }))
    return result
  }
}
