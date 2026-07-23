import { useEffect, useRef } from 'react'
import {
  getTasks, getPipeline, getContacts, getContactInteractions,
  getNotifLog, setNotifLog,
  updateOpportunity,
} from '@/services/graphService'
import {
  notifyOverdueSummary,
  notifyDueSoonSummary,
  notifyRFIFollowUp,
  notifyRFIResponseReminder,
  notifyStaleContacts,
} from '@/services/notifyService'

const TODAY = () => {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}
const LS_KEY = (type) => `tag_notif_${type}`

function localAlreadySentToday(type) {
  try { return localStorage.getItem(LS_KEY(type)) === TODAY() } catch { return false }
}

function markLocalSentToday(type) {
  try { localStorage.setItem(LS_KEY(type), TODAY()) } catch {}
}

function isTomorrow(dateStr) {
  if (!dateStr) return false
  const due = new Date(dateStr + 'T00:00:00')
  if (isNaN(due.getTime())) return false
  const tomorrow = new Date()
  tomorrow.setDate(tomorrow.getDate() + 1)
  return due.toDateString() === tomorrow.toDateString()
}

function isPastDue(dateStr) {
  if (!dateStr) return false
  const due = new Date(dateStr + 'T00:00:00')
  if (isNaN(due.getTime())) return false
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  return due < today
}

function daysAgo(dateStr) {
  if (!dateStr) return Infinity
  const d = new Date(dateStr + 'T00:00:00')
  if (isNaN(d.getTime())) return Infinity
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  return Math.floor((today - d) / (1000 * 60 * 60 * 24))
}

function hasValidInteractionDate(dateStr) {
  if (!dateStr) return false
  const date = new Date(`${dateStr}T00:00:00`)
  return !Number.isNaN(date.getTime())
}

function daysUntil(dateStr) {
  if (!dateStr) return Infinity
  const due = new Date(dateStr + 'T00:00:00')
  if (isNaN(due.getTime())) return Infinity
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  return Math.round((due - today) / (1000 * 60 * 60 * 24))
}

function responseReminderLogKey(opportunity, days) {
  const identifier = String(opportunity['Contract Number / Notice ID'] || opportunity._rowIndex || '').trim()
  return `rfi_response_${days}_${encodeURIComponent(identifier)}`
}

function contactStaleLogKey(contact) {
  return `contact_stale_${encodeURIComponent(String(contact.ContactID || contact.Email || contact.Name || contact._rowIndex || '').trim())}`
}

/**
 * Called once in AppShell after authentication.
 * Two-gate system: localStorage (instant, per-browser) then workbook NotifLog (shared).
 * RFI follow-up is per-opportunity (one-time), tracked via RFI Notified column.
 */
export function useAgingNotifications() {
  const checking = useRef(false)

  useEffect(() => {
    let nextDayTimer

    const runChecks = async () => {
      if (checking.current) return
      checking.current = true
      try {
        const today = TODAY()
        const overdueLocal = localAlreadySentToday('overdue')
        const dueSoonLocal = localAlreadySentToday('duesoon')
        const [allTasks, allOpps, allContacts, interactions, log] = await Promise.all([
          getTasks(),
          getPipeline(),
          getContacts(),
          getContactInteractions(),
          getNotifLog(),
        ])

        // ── Overdue tasks ──────────────────────────────────────────────
        if (!overdueLocal) {
          if (log['overdue'] === today) {
            markLocalSentToday('overdue')
          } else {
            const overdue = allTasks.filter(
              (t) => t.Status !== 'Done' && isPastDue(t.DueDate)
            )
            const sent = overdue.length === 0 || await notifyOverdueSummary(overdue)
            if (sent) {
              await setNotifLog('overdue', today)
              markLocalSentToday('overdue')
            }
          }
        }

        // ── Due soon tasks ─────────────────────────────────────────────
        if (!dueSoonLocal) {
          if (log['duesoon'] === today) {
            markLocalSentToday('duesoon')
          } else {
            const dueSoon = allTasks.filter(
              (t) => t.Status !== 'Done' && isTomorrow(t.DueDate)
            )
            const sent = dueSoon.length === 0 || await notifyDueSoonSummary(dueSoon)
            if (sent) {
              await setNotifLog('duesoon', today)
              markLocalSentToday('duesoon')
            }
          }
        }

        // ── RFI follow-up (per-opportunity, truly one-time) ───────────
        // No daily gate — check every session but only notify each opp once
        const rfiDue = allOpps.filter((o) => {
          if (o['TAG Pipeline Activity Phase'] !== 'Submitted RFI') return false
          if (o['RFI Notified']) return false           // already notified
          return daysAgo(o['Submission Date (Response Date)*']) >= 21
        })

        if (rfiDue.length > 0 && !localAlreadySentToday('rfi_followup')) {
          const sent = await notifyRFIFollowUp(rfiDue)
          if (sent) {
            markLocalSentToday('rfi_followup')
            // Write the notification date only after Teams accepted the card.
            await Promise.all(
              rfiDue.map((o) =>
                updateOpportunity(o._rowIndex, { 'RFI Notified': today })
                  .catch((err) => console.warn('[AgingNotif] RFI Notified update failed:', err.message))
              )
            )
          }
        }

        // ── Upcoming RFI responses (two days and one day) ─────────────
        // RFIs are the same records shown in the Opportunities RFIs tab.
        // Their response date is copied into Submission Date when they are
        // added from the New Opportunities list.
        const responseReminders = allOpps.filter((o) => {
          const isRFI = o['TAG Opportunity Phase'] === 'Identified' && o['Opportunity Outlook'] === 'New'
          const remaining = daysUntil(o['Submission Date (Response Date)*'])
          return isRFI && (remaining === 1 || remaining === 2)
        })

        for (const opportunity of responseReminders) {
          const remaining = daysUntil(opportunity['Submission Date (Response Date)*'])
          const key = responseReminderLogKey(opportunity, remaining)
          if (log[key] || localAlreadySentToday(key)) continue
          const sent = await notifyRFIResponseReminder(opportunity, remaining)
          if (!sent) continue
          await setNotifLog(key, today)
          log[key] = today
          markLocalSentToday(key)
        }

        // ── Contact follow-up ─────────────────────────────────────────
        // A contact becomes stale 30 days after their latest logged
        // interaction. Contacts with no interaction are excluded, because
        // the CRM has no reliable historical date to measure from. Reminders
        // repeat no more than every 14 days while the contact remains stale.
        if (Array.isArray(interactions)) {
          const lastInteractionByContact = new Map()
          interactions.forEach((interaction) => {
            const contactId = String(interaction.ContactID || '').trim()
            const date = String(interaction['Interaction Date'] || '').trim()
            if (!contactId || !date) return
            if (!lastInteractionByContact.has(contactId) || date > lastInteractionByContact.get(contactId)) {
              lastInteractionByContact.set(contactId, date)
            }
          })

          const staleContacts = allContacts
            .map((contact) => ({ ...contact, lastInteraction: lastInteractionByContact.get(String(contact.ContactID || '').trim()) || '' }))
            .filter((contact) => {
              // A contact enters the follow-up cycle only after the team has
              // logged at least one valid interaction. Imported and newly
              // created contacts therefore never become stale by default.
              if (!hasValidInteractionDate(contact.lastInteraction)) return false
              if (daysAgo(contact.lastInteraction) < 30) return false
              const lastSent = log[contactStaleLogKey(contact)]
              return !localAlreadySentToday(contactStaleLogKey(contact)) && (!lastSent || daysAgo(lastSent) >= 14)
            })

          const contactsForNotification = staleContacts.slice(0, 5)
          if (contactsForNotification.length > 0) {
            const sent = await notifyStaleContacts(contactsForNotification)
            if (sent) {
              await Promise.all(contactsForNotification.map(async (contact) => {
                const key = contactStaleLogKey(contact)
                await setNotifLog(key, today)
                log[key] = today
                markLocalSentToday(key)
              }))
            }
          }
        }

      } catch (err) {
        console.warn('[AgingNotif] Check failed:', err.message)
      } finally {
        checking.current = false
      }
    }

    const scheduleNextDay = () => {
      const next = new Date()
      next.setHours(24, 0, 8, 0)
      nextDayTimer = setTimeout(async () => {
        await runChecks()
        scheduleNextDay()
      }, Math.max(1000, next.getTime() - Date.now()))
    }

    const initialTimer = setTimeout(runChecks, 8000)
    scheduleNextDay()

    return () => {
      clearTimeout(initialTimer)
      clearTimeout(nextDayTimer)
    }
  }, [])
}
