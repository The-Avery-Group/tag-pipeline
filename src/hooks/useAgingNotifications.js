import { useEffect, useRef } from 'react'
import {
  getTasks, getPipeline,
  getNotifLog, setNotifLog,
  updateOpportunity,
} from '@/services/graphService'
import {
  notifyOverdueSummary,
  notifyDueSoonSummary,
  notifyRFIFollowUp,
  notifyStaleOpportunities,
} from '@/services/notifyService'

const TODAY = () => new Date().toISOString().split('T')[0]
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

const EARLY_PHASES = new Set(['Identified', 'Research'])

/**
 * Called once in AppShell after authentication.
 * Two-gate system: localStorage (instant, per-browser) then workbook NotifLog (shared).
 * RFI follow-up is per-opportunity (one-time), tracked via RFI Notified column.
 * Stale opportunity auto-updates Last Modified* silently after notifying.
 */
export function useAgingNotifications() {
  const ran = useRef(false)

  useEffect(() => {
    if (ran.current) return
    ran.current = true

    const overdueLocal  = localAlreadySentToday('overdue')
    const dueSoonLocal  = localAlreadySentToday('duesoon')
    const staleLocal    = localAlreadySentToday('opp_stale')

    // Skip entirely if all daily types already sent in this browser today
    const needsDailyCheck = !overdueLocal || !dueSoonLocal || !staleLocal

    const timer = setTimeout(async () => {
      try {
        const today = TODAY()
        const [allTasks, allOpps, log] = await Promise.all([
          getTasks(),
          getPipeline(),
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
            if (overdue.length > 0) await notifyOverdueSummary(overdue)
            await setNotifLog('overdue', today)
            markLocalSentToday('overdue')
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
            if (dueSoon.length > 0) await notifyDueSoonSummary(dueSoon)
            await setNotifLog('duesoon', today)
            markLocalSentToday('duesoon')
          }
        }

        // ── Stale opportunities (early phases, no activity ≥7 days) ──
        if (!staleLocal) {
          if (log['opp_stale'] === today) {
            markLocalSentToday('opp_stale')
          } else {
            const stale = allOpps.filter((o) => {
              if (!EARLY_PHASES.has(o['TAG Opportunity Phase'])) return false
              return daysAgo(o['Last Modified*']) >= 7
            })

            if (stale.length > 0) {
              await notifyStaleOpportunities(stale)
              // Silently write today to Last Modified* for each stale opp
              // so the clock resets — fire all in parallel, catch per item
              await Promise.all(
                stale.map((o) =>
                  updateOpportunity(o._rowIndex, { 'Last Modified*': today })
                    .catch((err) => console.warn('[AgingNotif] Last Modified update failed:', err.message))
                )
              )
            }
            await setNotifLog('opp_stale', today)
            markLocalSentToday('opp_stale')
          }
        }

        // ── RFI follow-up (per-opportunity, truly one-time) ───────────
        // No daily gate — check every session but only notify each opp once
        const rfiDue = allOpps.filter((o) => {
          if (o['TAG Pipeline Activity Phase'] !== 'Submitted RFI') return false
          if (o['RFI Notified']) return false           // already notified
          return daysAgo(o['Submission Date (Response Date)*']) >= 21
        })

        if (rfiDue.length > 0) {
          await notifyRFIFollowUp(rfiDue)
          // Write notification date to RFI Notified column for each opp
          // Use Promise.all — fast, Graph API handles small team volume
          await Promise.all(
            rfiDue.map((o) =>
              updateOpportunity(o._rowIndex, { 'RFI Notified': today })
                .catch((err) => console.warn('[AgingNotif] RFI Notified update failed:', err.message))
            )
          )
        }

      } catch (err) {
        console.warn('[AgingNotif] Check failed:', err.message)
      }
    }, 8000)

    return () => clearTimeout(timer)
  }, [])
}
