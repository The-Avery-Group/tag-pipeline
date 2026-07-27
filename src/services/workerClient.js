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
