/**
 * Session cache coordinator for workbook data.
 *
 * The previous approach downloaded every commonly-used table every 30 seconds.
 * This version checks the workbook drive item's eTag once a minute, while also
 * refreshing the tables used by the visible page on a bounded schedule. The
 * targeted refresh is intentional: SharePoint's drive-item eTag is useful as
 * an early signal, but it does not reliably move for every direct table edit.
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
const ACTIVE_REFRESH_INTERVAL_MS = 3 * 60 * 1000
const RETURN_REFRESH_AFTER_MS = 60 * 1000
const PAGE_ENTRY_FRESH_MS = 30 * 1000
const CORE_TABLES = ['PipelineTable', 'TasksTable', 'DataValidationTable']
const SECONDARY_TABLES = [
  'NotesTable',
  'ContactsTable',
  'NewOpportunitiesTable',
  'PartnersTable',
  'ContactInteractionsTable',
]
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
let activeTableSignature = ''
let activeTables = new Set(CORE_TABLES)
const dirtyTables = new Set()
const lastTableRefreshAt = new Map()
const verificationTimers = new Map()
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
  if (refreshed.length) {
    const refreshedAt = Date.now()
    refreshed.forEach((tableName) => {
      lastTableRefreshAt.set(tableName, refreshedAt)
      dirtyTables.delete(tableName)
    })
  }
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

/**
 * Re-read newly created rows without making the save button wait for a full
 * table download. Calls for the same table are coalesced into one verification.
 */
export function verifyCacheInBackground(tableNames = [], delayMs = 350) {
  const targets = [...new Set(tableNames)].filter((tableName) => loaders[tableName])
  targets.forEach((tableName) => {
    if (verificationTimers.has(tableName)) clearTimeout(verificationTimers.get(tableName))
    const timer = setTimeout(() => {
      verificationTimers.delete(tableName)
      forceRefreshCache([tableName]).catch((error) => {
        dirtyTables.add(tableName)
        console.warn(`[Cache] Background verification failed for ${tableName}:`, error.message)
      })
    }, delayMs)
    verificationTimers.set(tableName, timer)
  })
}

function cachedTargets(tableNames) {
  const cached = new Set(getCachedTableNames())
  return tableNames.filter((tableName) => cached.has(tableName))
}

function activeTargets({ cachedOnly = true } = {}) {
  const targets = [...activeTables].filter((tableName) => loaders[tableName])
  return cachedOnly ? cachedTargets(targets) : targets
}

async function refreshActiveTables({ returningToTab = false, pageEntry = false } = {}) {
  if (!warmed || document.hidden) return []
  const now = Date.now()
  const targets = activeTargets({ cachedOnly: false }).filter((tableName) => {
    const age = now - (lastTableRefreshAt.get(tableName) || 0)
    if (dirtyTables.has(tableName)) return true
    if (returningToTab) return age >= RETURN_REFRESH_AFTER_MS
    if (pageEntry) return age >= PAGE_ENTRY_FRESH_MS
    return age >= ACTIVE_REFRESH_INTERVAL_MS
  })
  if (!targets.length) return []
  const refreshed = await loadTables(targets, {
    invalidate: true,
    tolerateFailures: true,
  })
  await notify(refreshed)
  return refreshed
}

/**
 * Tell the cache coordinator which workbook tables matter to the current
 * route. Inactive cached tables are retained for fast navigation, but are not
 * repeatedly downloaded in the background. They refresh when their page is
 * opened, when explicitly requested, or after the workbook version signals a
 * change and that page becomes active.
 */
export function setActiveCacheTables(tableNames = []) {
  const next = [...new Set(tableNames)].filter((tableName) => loaders[tableName])
  const signature = [...next].sort().join('|')
  if (signature === activeTableSignature) return
  activeTableSignature = signature
  activeTables = new Set(next)
  if (warmed && !document.hidden) {
    void refreshActiveTables({ pageEntry: true })
  }
}

async function refreshIfWorkbookChanged({ returningToTab = false } = {}) {
  if (pollInFlight || document.hidden) return
  pollInFlight = true
  try {
    const version = await getWorkbookVersion()
    const next = version.eTag || version.lastModifiedDateTime || ''
    const versionChanged = Boolean(next && knownWorkbookVersion && next !== knownWorkbookVersion)
    if (!knownWorkbookVersion) {
      knownWorkbookVersion = next
    }

    if (versionChanged) {
      const cached = getCachedTableNames()
      const active = new Set(activeTargets())
      cached.forEach((tableName) => {
        if (!active.has(tableName)) dirtyTables.add(tableName)
      })
      const refreshed = await loadTables([...active], {
        invalidate: true,
        tolerateFailures: true,
      })
      knownWorkbookVersion = next
      await notify(refreshed)
      return
    }

    await refreshActiveTables({ returningToTab })
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
  activeTableSignature = ''
  activeTables = new Set(CORE_TABLES)
  dirtyTables.clear()
  lastTableRefreshAt.clear()
  verificationTimers.forEach((timer) => clearTimeout(timer))
  verificationTimers.clear()
}
