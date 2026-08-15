const viteEnv = import.meta.env || {}

export const CURRENT_APP_VERSION = Object.freeze({
  buildId: String(viteEnv.VITE_APP_BUILD_ID || 'development'),
  builtAt: String(viteEnv.VITE_APP_BUILT_AT || ''),
})

export const APP_VERSION_POLL_MS = 30_000

export function isNewerAppVersion(candidate, current = CURRENT_APP_VERSION) {
  if (!candidate?.buildId || candidate.buildId === current?.buildId) return false
  const candidateTime = Date.parse(candidate.builtAt || '')
  const currentTime = Date.parse(current?.builtAt || '')
  if (Number.isFinite(candidateTime) && Number.isFinite(currentTime)) return candidateTime > currentTime
  return true
}

export async function fetchDeployedAppVersion({ fetchImpl = fetch, now = Date.now } = {}) {
  const baseUrl = String(viteEnv.BASE_URL || '/tag-pipeline/')
  const url = new URL(`${baseUrl}version.json`, window.location.origin)
  url.searchParams.set('_tag_check', String(now()))
  const response = await fetchImpl(url.toString(), {
    cache: 'no-store',
    credentials: 'same-origin',
    headers: { 'Cache-Control': 'no-cache', Pragma: 'no-cache' },
  })
  if (!response.ok) throw new Error(`Version check returned ${response.status}`)
  const contentType = response.headers?.get?.('content-type') || ''
  if (!contentType.toLowerCase().includes('application/json')) throw new Error('Version check did not return JSON')
  const version = await response.json()
  if (!version?.buildId) throw new Error('Version check returned an invalid manifest')
  return { buildId: String(version.buildId), builtAt: String(version.builtAt || '') }
}

export function reloadWithCacheBypass(buildId = Date.now(), locationObject = window.location) {
  const current = new URL(locationObject.href)
  const basePath = String(viteEnv.BASE_URL || '/tag-pipeline/')
  const normalizedBase = basePath.endsWith('/') ? basePath : `${basePath}/`
  const baseWithoutTrailingSlash = normalizedBase.slice(0, -1)
  const routePath = current.pathname.startsWith(baseWithoutTrailingSlash)
    ? current.pathname.slice(baseWithoutTrailingSlash.length) || '/'
    : '/'
  const returnRoute = `${routePath.startsWith('/') ? routePath : `/${routePath}`}${current.search}${current.hash}`
  const entryUrl = new URL(normalizedBase, current.origin)
  entryUrl.searchParams.set('_tag_build', String(buildId))
  if (returnRoute !== '/') entryUrl.searchParams.set('redirect', returnRoute)
  locationObject.replace(entryUrl.toString())
}
