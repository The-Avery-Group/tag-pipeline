import { useEffect, useRef } from 'react'
import { getTasks, getNotifLog, setNotifLog } from '@/services/graphService'
import { notifyOverdueSummary, notifyDueSoonSummary } from '@/services/notifyService'

const TODAY = () => new Date().toISOString().split('T')[0]
const LS_KEY = (type) => `tag_notif_${type}`

function localAlreadySentToday(type) {
  try {
    return localStorage.getItem(LS_KEY(type)) === TODAY()
  } catch { return false }
}

function markLocalSentToday(type) {
  try {
    localStorage.setItem(LS_KEY(type), TODAY())
  } catch {}
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

/**
 * Called once in AppShell. Gate 1: localStorage (instant, blocks refresh
 * re-fires). Gate 2: workbook NotifLog (shared across users/browsers).
 * Only the first session of the day that passes both gates sends the card.
 */
export function useAgingNotifications() {
  const ran = useRef(false)

  useEffect(() => {
    if (ran.current) return
    ran.current = true

    // Skip entirely if both types already sent today in this browser
    const overdueLocal  = localAlreadySentToday('overdue')
    const dueSoonLocal  = localAlreadySentToday('duesoon')
    if (overdueLocal && dueSoonLocal) return

    const timer = setTimeout(async () => {
      try {
        const today = TODAY()
        const [allTasks, log] = await Promise.all([getTasks(), getNotifLog()])
        const active = allTasks.filter((t) => t.Status !== 'Done')

        // ── Overdue ────────────────────────────────────────────────────
        if (!overdueLocal) {
          if (log['overdue'] === today) {
            // Another user already sent it today — just mark our localStorage
            markLocalSentToday('overdue')
          } else {
            const overdue = active.filter((t) => isPastDue(t.DueDate))
            if (overdue.length > 0) {
              await notifyOverdueSummary(overdue)
              await setNotifLog('overdue', today)
            }
            markLocalSentToday('overdue')
          }
        }

        // ── Due soon ───────────────────────────────────────────────────
        if (!dueSoonLocal) {
          if (log['duesoon'] === today) {
            markLocalSentToday('duesoon')
          } else {
            const dueSoon = active.filter((t) => isTomorrow(t.DueDate))
            if (dueSoon.length > 0) {
              await notifyDueSoonSummary(dueSoon)
              await setNotifLog('duesoon', today)
            }
            markLocalSentToday('duesoon')
          }
        }
      } catch (err) {
        console.warn('[AgingNotif] Check failed:', err.message)
      }
    }, 8000)

    return () => clearTimeout(timer)
  }, [])
}
