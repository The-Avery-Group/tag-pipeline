import { useEffect, useRef } from 'react'
import { getTasks, getNotifLog, setNotifLog } from '@/services/graphService'
import { notifyOverdueSummary, notifyDueSoonSummary } from '@/services/notifyService'

const TODAY = () => new Date().toISOString().split('T')[0]

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
 * Called once in AppShell. Runs one check on mount (after a short delay
 * to allow the cache to warm), then never again in the same session.
 * Uses the DataValidationTable's Key/LastSent columns to ensure only
 * one user session per day actually sends each notification type.
 */
export function useAgingNotifications() {
  const ran = useRef(false)

  useEffect(() => {
    if (ran.current) return
    ran.current = true

    // Delay so cache has time to warm and token to resolve
    const timer = setTimeout(async () => {
      try {
        const [allTasks, log] = await Promise.all([getTasks(), getNotifLog()])
        const today = TODAY()
        const active = allTasks.filter((t) => t.Status !== 'Done')

        // ── Overdue summary ────────────────────────────────────────────
        if (log['overdue'] !== today) {
          const overdue = active.filter((t) => isPastDue(t.DueDate))
          if (overdue.length > 0) {
            await notifyOverdueSummary(overdue)
            await setNotifLog('overdue', today)
          }
        }

        // ── Due-soon summary ───────────────────────────────────────────
        if (log['duesoon'] !== today) {
          const dueSoon = active.filter((t) => isTomorrow(t.DueDate))
          if (dueSoon.length > 0) {
            await notifyDueSoonSummary(dueSoon)
            await setNotifLog('duesoon', today)
          }
        }
      } catch (err) {
        console.warn('[AgingNotif] Check failed:', err.message)
      }
    }, 8000)  // 8-second delay — cache warm + token acquisition

    return () => clearTimeout(timer)
  }, [])
}