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
const listeners = new Set()

export function onCacheRefresh(listener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function notify(tableNames) {
  listeners.forEach((listener) => listener(tableNames))
}

export function isCacheWarmed() {
  return warmed
}

async function loadTables(tableNames, { invalidate = false } = {}) {
  const unique = [...new Set(tableNames)].filter((tableName) => loaders[tableName])
  if (!unique.length) return []
  if (invalidate) invalidateTables(unique)
  await Promise.all(unique.map((tableName) => loaders[tableName]()))
  return unique
}

async function recordWorkbookVersion() {
  const version = await getWorkbookVersion()
  knownWorkbookVersion = version.eTag || version.lastModifiedDateTime || knownWorkbookVersion
  return knownWorkbookVersion
}

async function warmSecondaryTables() {
  try {
    await loadTables(SECONDARY_TABLES)
    notify(SECONDARY_TABLES)
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
    notify(CORE_TABLES)
    // Continue warming the search/contact datasets without blocking the app.
    void warmSecondaryTables()
  } catch (error) {
    console.warn('[Cache] Core preload failed, pages will fetch on demand:', error.message)
  } finally {
    warming = false
  }
}

/**
 * Refresh data immediately after a successful write. Pass affected workbook
 * tables whenever known. With no table list, only the tables already cached
 * in this browser session are refreshed, never the whole workbook blindly.
 */
export async function invalidateCache(tableNames = []) {
  const targets = tableNames.length ? tableNames : getCachedTableNames()
  try {
    const refreshed = await loadTables(targets, { invalidate: true })
    await recordWorkbookVersion().catch(() => '')
    notify(refreshed)
  } catch (error) {
    console.warn('[Cache] Refresh failed:', error.message)
  }
}

async function refreshIfWorkbookChanged() {
  if (pollInFlight || document.hidden) return
  pollInFlight = true
  try {
    const version = await getWorkbookVersion()
    const next = version.eTag || version.lastModifiedDateTime || ''
    if (!next) return
    if (!knownWorkbookVersion) {
      knownWorkbookVersion = next
      return
    }
    if (next === knownWorkbookVersion) return

    knownWorkbookVersion = next
    const refreshed = await loadTables(getCachedTableNames(), { invalidate: true })
    notify(refreshed)
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
    if (!document.hidden) void refreshIfWorkbookChanged()
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
}
