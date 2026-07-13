/**
 * dataCache.js
 * Preloads the workbook datasets into memory and keeps them fresh
 * by polling for changes every POLL_INTERVAL_MS.
 *
 * How it works:
 *  - warmCache()     → called once after login, loads all four tables in parallel
 *  - startPolling()  → called after warmCache, silently re-fetches in background
 *  - stopPolling()   → called on logout to clean up
 *  - invalidate()    → called by hooks after a write, forces immediate re-fetch
 *
 * The graphService cache Map is cleared before each re-fetch so fresh
 * data comes from the API rather than the stale in-memory copy.
 */

import {
  getPipeline, getTasks, getNotes, getContacts, getValidationLists,
  getSAMOpportunities,
  invalidateAll,
} from '@/services/graphService'

// Refresh active tabs often enough for collaborative work without repeatedly
// competing with users' own Graph writes. Hidden tabs do not poll at all.
const POLL_INTERVAL_MS = 30 * 1000

let _warmed    = false
let _warming   = false
let _pollTimer = null
let _pollInFlight = false
let _visibilityHandler = null

// Listeners notified when cache refreshes so hooks can re-render
const _listeners = new Set()

export function onCacheRefresh(fn) {
  _listeners.add(fn)
  return () => _listeners.delete(fn)   // returns unsubscribe function
}

function _notify() {
  _listeners.forEach((fn) => fn())
}

export function isCacheWarmed() {
  return _warmed
}

async function _fetchAll() {
  // Clear the graphService in-memory cache so we actually hit the API
  invalidateAll()
  await Promise.all([
    getPipeline(),
    getTasks(),
    getNotes(),
    getContacts(),
    getValidationLists(),
    getSAMOpportunities(),
  ])
}

async function _refreshInBackground() {
  if (_pollInFlight || document.hidden) return
  _pollInFlight = true
  try {
    await _fetchAll()
    _notify()
  } catch {
    // Preserve the current cache if a background refresh fails.
  } finally {
    _pollInFlight = false
  }
}

export async function warmCache() {
  if (_warming || _warmed) return
  _warming = true
  try {
    await _fetchAll()
    _warmed = true
    _notify()
  } catch (err) {
    console.warn('[Cache] Preload failed, hooks will fetch on demand:', err.message)
  } finally {
    _warming = false
  }
}

/**
 * Force an immediate refresh — called by hooks after any write
 * so the in-memory data reflects the change right away.
 */
export async function invalidateCache() {
  try {
    await _fetchAll()
    _notify()
  } catch (err) {
    console.warn('[Cache] Refresh failed:', err.message)
  }
}

export function startPolling() {
  if (_pollTimer) return   // already polling
  _pollTimer = setInterval(_refreshInBackground, POLL_INTERVAL_MS)
  _visibilityHandler = () => {
    if (!document.hidden) _refreshInBackground()
  }
  document.addEventListener('visibilitychange', _visibilityHandler)
}

export function stopPolling() {
  if (_pollTimer) {
    clearInterval(_pollTimer)
    _pollTimer = null
  }
  if (_visibilityHandler) {
    document.removeEventListener('visibilitychange', _visibilityHandler)
    _visibilityHandler = null
  }
  _pollInFlight = false
  _warmed  = false
  _warming = false
}
