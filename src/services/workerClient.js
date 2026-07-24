/**
 * Authenticated browser client for Cloudflare Worker routes.
 *
 * The same delegated Microsoft Graph token used to access the workbook is
 * attached to Worker requests. The Worker validates its Entra signature,
 * tenant, audience, and originating application before serving a request.
 */
import { getToken } from '@/services/graphService'

export const WORKER_URL = import.meta.env.VITE_API_BASE_URL

export async function workerFetch(path, options = {}) {
  if (!WORKER_URL) throw new Error('VITE_API_BASE_URL not set')

  const token = await getToken()
  const headers = new Headers(options.headers || {})
  headers.set('Authorization', `Bearer ${token}`)

  return fetch(`${WORKER_URL}${path}`, {
    ...options,
    headers,
  })
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
