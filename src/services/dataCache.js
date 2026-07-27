/**
 * Session cache coordinator for workbook data.
 *
 * The previous approach downloaded every commonly-used table every 30 seconds.
 * This version checks the workbook drive item's eTag once a minute and only
 * reloads tables that are already in use when the workbook actually changed.
 * Writes invalidate only their affected tables.
 */
import {
  getPipeline,
  getTasks,
  getNotes,
  getContacts,
  getValidationLists,
  getSAMOpportunities,
  getPartners,
  getContactInteractions,
  getWorkbookVersion,
  getCachedTableNames,
  invalidateTables,
} from '@/services/graphService'

const POLL_INTERVAL_MS = 60 * 1000
const FORCED_REFRESH_INTERVAL_MS = 3 * 60 * 1000
const SLOW_REFRESH_INTERVAL_MS = 15 * 60 * 1000
const RETURN_REFRESH_AFTER_MS = 60 * 1000
const CORE_TABLES = ['PipelineTable', 'TasksTable', 'DataValidationTable']
const SECONDARY_TABLES = [
  'NotesTable',
  'ContactsTable',
  'NewOpportunitiesTable',
  'PartnersTable',
  'ContactInteractionsTable',
]
const FREQUENT_TABLES = [
  'PipelineTable',
  'TasksTable',
  'NotesTable',
  'ContactsTable',
  'NewOpportunitiesTable',
  'ContactInteractionsTable',
]
const SLOW_TABLES = ['DataValidationTable', 'PartnersTable']

const loaders = {
  PipelineTable: getPipeline,
  TasksTable: getTasks,
  NotesTable: getNotes,
  ContactsTable: getContacts,
  DataValidationTable: getValidationLists,
  NewOpportunitiesTable: getSAMOpportunities,
  PartnersTable: getPartners,
  ContactInteractionsTable: getContactInteractions,
}

let warmed = false
let warming = false
let pollTimer = null
let pollInFlight = false
let visibilityHandler = null
let knownWorkbookVersion = ''
let lastSuccessfulRefreshAt = 0
let lastForcedRefreshAt = 0
let lastSlowRefreshAt = 0
const listeners = new Set()

export function onCacheRefresh(listener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

async function notify(tableNames) {
  await Promise.allSettled(
    [...listeners].map((listener) => Promise.resolve().then(() => listener(tableNames)))
  )
}

export function isCacheWarmed() {
  return warmed
}

async function loadTables(tableNames, { invalidate = false, tolerateFailures = false } = {}) {
  const unique = [...new Set(tableNames)].filter((tableName) => loaders[tableName])
  if (!unique.length) return []
  if (invalidate) invalidateTables(unique)
  const results = await Promise.allSettled(unique.map((tableName) => loaders[tableName]()))
  const refreshed = unique.filter((_, index) => results[index].status === 'fulfilled')
  if (refreshed.length) lastSuccessfulRefreshAt = Date.now()
  const failure = results.find((result) => result.status === 'rejected')
  if (failure && !tolerateFailures) throw failure.reason
  if (failure && tolerateFailures) {
    console.warn('[Cache] Some tables could not refresh:', failure.reason?.message || failure.reason)
  }
  return refreshed
}

async function recordWorkbookVersion() {
  const version = await getWorkbookVersion()
  knownWorkbookVersion = version.eTag || version.lastModifiedDateTime || knownWorkbookVersion
  return knownWorkbookVersion
}

async function warmSecondaryTables() {
  try {
    const refreshed = await loadTables(SECONDARY_TABLES, { tolerateFailures: true })
    await notify(refreshed)
  } catch (error) {
    // Secondary datasets should never delay the workspace becoming usable.
    console.warn('[Cache] Secondary preload failed:', error.message)
  }
}

export async function warmCache() {
  if (warming || warmed) return
  warming = true
  try {
    await loadTables(CORE_TABLES)
    await recordWorkbookVersion().catch(() => '')
    lastForcedRefreshAt = Date.now()
    lastSlowRefreshAt = Date.now()
    warmed = true
    await notify(CORE_TABLES)
    // Continue warming the search/contact datasets without blocking the app.
    void warmSecondaryTables()
  } catch (error) {
    console.warn('[Cache] Core preload failed, pages will fetch on demand:', error.message)
  } finally {
    warming = false
  }
}

/**
 * Explicitly bypass the in-memory row cache and notify mounted consumers after
 * fresh workbook data has arrived. Manual refresh actions use this path.
 */
export async function forceRefreshCache(tableNames = []) {
  const targets = tableNames.length ? tableNames : getCachedTableNames()
  const refreshed = await loadTables(targets, { invalidate: true })
  await notify(refreshed)
  return refreshed
}

/**
 * Refresh data immediately after a successful write. Pass affected workbook
 * tables whenever known. With no table list, only the tables already cached
 * in this browser session are refreshed, never the whole workbook blindly.
 */
export async function invalidateCache(tableNames = []) {
  try {
    await forceRefreshCache(tableNames)
  } catch (error) {
    console.warn('[Cache] Refresh failed:', error.message)
  }
}

function cachedTargets(tableNames) {
  const cached = new Set(getCachedTableNames())
  return tableNames.filter((tableName) => cached.has(tableName))
}

async function refreshIfWorkbookChanged({ returningToTab = false } = {}) {
  if (pollInFlight || document.hidden) return
  pollInFlight = true
  try {
    const now = Date.now()
    const version = await getWorkbookVersion()
    const next = version.eTag || version.lastModifiedDateTime || ''
    const versionChanged = Boolean(next && knownWorkbookVersion && next !== knownWorkbookVersion)
    if (!knownWorkbookVersion) {
      knownWorkbookVersion = next
    }

    if (versionChanged) {
      const refreshed = await loadTables(getCachedTableNames(), {
        invalidate: true,
        tolerateFailures: true,
      })
      knownWorkbookVersion = next
      lastForcedRefreshAt = now
      lastSlowRefreshAt = now
      await notify(refreshed)
      return
    }

    const returningStale = returningToTab &&
      now - lastSuccessfulRefreshAt >= RETURN_REFRESH_AFTER_MS
    const frequentDue = now - lastForcedRefreshAt >= FORCED_REFRESH_INTERVAL_MS
    if (returningStale || frequentDue) {
      const refreshed = await loadTables(cachedTargets(FREQUENT_TABLES), {
        invalidate: true,
        tolerateFailures: true,
      })
      lastForcedRefreshAt = now
      await notify(refreshed)
    }

    if (now - lastSlowRefreshAt >= SLOW_REFRESH_INTERVAL_MS) {
      const refreshed = await loadTables(cachedTargets(SLOW_TABLES), {
        invalidate: true,
        tolerateFailures: true,
      })
      lastSlowRefreshAt = now
      await notify(refreshed)
    }
  } catch (error) {
    // A transient Graph failure should preserve the visible workspace.
    console.warn('[Cache] Background version check failed:', error.message)
  } finally {
    pollInFlight = false
  }
}

export function startPolling() {
  if (pollTimer) return
  pollTimer = setInterval(refreshIfWorkbookChanged, POLL_INTERVAL_MS)
  visibilityHandler = () => {
    if (!document.hidden) void refreshIfWorkbookChanged({ returningToTab: true })
  }
  document.addEventListener('visibilitychange', visibilityHandler)
}

export function stopPolling() {
  if (pollTimer) clearInterval(pollTimer)
  pollTimer = null
  if (visibilityHandler) document.removeEventListener('visibilitychange', visibilityHandler)
  visibilityHandler = null
  pollInFlight = false
  warmed = false
  warming = false
  knownWorkbookVersion = ''
  lastSuccessfulRefreshAt = 0
  lastForcedRefreshAt = 0
  lastSlowRefreshAt = 0
}
