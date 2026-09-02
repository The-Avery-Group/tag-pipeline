/**
 * Authenticated browser client for Cloudflare Worker routes.
 *
 * The same delegated Microsoft Graph token used to access the workbook is
 * attached to Worker requests. The Worker validates its Entra signature,
 * tenant, audience, and originating application before serving a request.
 */
import { getToken, requestSessionRefresh } from '@/services/graphService'

export const WORKER_URL = import.meta.env.VITE_API_BASE_URL

export async function workerFetch(path, options = {}) {
  if (!WORKER_URL) throw new Error('VITE_API_BASE_URL not set')

  const { interactiveAuth = false, ...fetchOptions } = options
  const token = await getToken({ interactive: interactiveAuth })
  const headers = new Headers(fetchOptions.headers || {})
  headers.set('Authorization', `Bearer ${token}`)

  const response = await fetch(`${WORKER_URL}${path}`, {
    ...fetchOptions,
    headers,
  })
  if (response.status === 401) requestSessionRefresh(new Error('Your workspace session needs to be refreshed'))
  return response
}

export async function workerJson(path, options = {}) {
  const response = await workerFetch(path, options)
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) {
    const error = new Error(payload.error || `Worker API error: ${response.status}`)
    error.status = response.status
    error.code = payload.code || ''
    throw error
  }
  return payload
}

const adaptivePollers = new Map()
const pollTabId = typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : String(Date.now())

function adaptiveDelay(elapsed) {
  if (elapsed < 30_000) return 3_000
  if (elapsed < 2 * 60_000) return 10_000
  if (elapsed < 10 * 60_000) return 30_000
  return 60_000
}

/**
 * One adaptive status poll per browser tab and, where supported, per browser
 * profile. Results are broadcast to other tabs so they do not repeat the same
 * authenticated Worker request.
 */
export function startAdaptivePolling({ key, poll, onResult, shouldContinue, immediate = true }) {
  if (adaptivePollers.has(key)) return adaptivePollers.get(key)
  const startedAt = Date.now()
  const leaseKey = `tag_poll_lease:${key}`
  const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(`tag-poll:${key}`) : null
  let timer = null
  let stopped = false
  let inFlight = false
  const resume = () => { if (!document.hidden && navigator.onLine) schedule(0) }

  const delay = () => adaptiveDelay(Date.now() - startedAt)
  const ownsLease = () => {
    if (typeof localStorage === 'undefined') return true
    try {
      const now = Date.now()
      const current = JSON.parse(localStorage.getItem(leaseKey) || 'null')
      if (current?.owner !== pollTabId && Number(current?.expiresAt || 0) > now) return false
      localStorage.setItem(leaseKey, JSON.stringify({ owner: pollTabId, expiresAt: now + Math.max(15_000, delay() * 2) }))
      return JSON.parse(localStorage.getItem(leaseKey) || 'null')?.owner === pollTabId
    } catch { return true }
  }

  const stop = () => {
    if (stopped) return
    stopped = true
    if (timer) window.clearTimeout(timer)
    channel?.close()
    adaptivePollers.delete(key)
    document.removeEventListener('visibilitychange', resume)
    window.removeEventListener('online', resume)
    try {
      const current = JSON.parse(localStorage.getItem(leaseKey) || 'null')
      if (current?.owner === pollTabId) localStorage.removeItem(leaseKey)
    } catch {}
  }

  const schedule = (wait = delay()) => {
    if (stopped) return
    if (timer) window.clearTimeout(timer)
    timer = window.setTimeout(run, wait)
  }

  const accept = async (result) => {
    await onResult?.(result)
    if (shouldContinue && !shouldContinue(result)) stop()
  }

  const run = async () => {
    if (stopped || inFlight) return
    if (document.hidden || !navigator.onLine || !ownsLease()) {
      schedule(document.hidden || !navigator.onLine ? 60_000 : delay())
      return
    }
    inFlight = true
    try {
      const result = await poll()
      if (result !== undefined && result !== null) {
        channel?.postMessage({ result })
        await accept(result)
      }
    } catch {
      // Preserve the last status and retry with the existing backoff.
    } finally {
      inFlight = false
      if (!stopped) schedule()
    }
  }

  channel?.addEventListener('message', (event) => {
    if (event.data?.result !== undefined) accept(event.data.result).catch(() => {})
  })
  document.addEventListener('visibilitychange', resume)
  window.addEventListener('online', resume)
  adaptivePollers.set(key, stop)
  schedule(immediate ? 0 : delay())
  return stop
}
