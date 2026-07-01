/**
 * dataCache.js
 * Preloads all four Excel tables into memory and keeps them fresh
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

// How often to poll for external changes (e.g. another user's edits).
// Was 2 minutes — shortened so changes from other sessions show up without
// a manual refresh. Trade-off: more Graph API calls per active tab (6
// parallel GETs per tick). 20s is a reasonable balance; raise it if this
// starts hitting Graph API throttling limits with more concurrent users.
const POLL_INTERVAL_MS = 20 * 1000

let _warmed    = false
let _warming   = false
let _pollTimer = null

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
  _pollTimer = setInterval(async () => {
    try {
      await _fetchAll()
      _notify()
    } catch {
      // Silent fail — stale cache is better than a crash
    }
  }, POLL_INTERVAL_MS)
}

export function stopPolling() {
  if (_pollTimer) {
    clearInterval(_pollTimer)
    _pollTimer = null
  }
  _warmed  = false
  _warming = false
}
