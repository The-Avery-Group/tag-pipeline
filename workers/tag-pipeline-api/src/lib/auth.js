const GRAPH_AUDIENCES = new Set([
  '00000003-0000-0000-c000-000000000000',
  'https://graph.microsoft.com',
  'https://graph.microsoft.com/',
])

const CLOCK_SKEW_SECONDS = 300
const JWK_CACHE_MS = 6 * 60 * 60 * 1000
const jwkCaches = new Map()

export class AuthError extends Error {
  constructor(message, status = 401, code = 'unauthorized') {
    super(message)
    this.status = status
    this.code = code
  }
}

function decodeSegment(segment) {
  const normalized = String(segment || '').replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
  const binary = atob(padded)
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
  return JSON.parse(new TextDecoder().decode(bytes))
}

function validIssuer(issuer, tenantId) {
  // Microsoft Graph can issue a v1-format access token even when MSAL uses
  // the v2 authorization endpoint. Both forms are Microsoft issuers for the
  // same tenant. The tenant claim remains the organization boundary.
  return new Set([
    `https://login.microsoftonline.com/${tenantId}/v2.0`,
    `https://login.microsoftonline.com/${tenantId}/`,
    `https://sts.windows.net/${tenantId}/`,
  ]).has(String(issuer || ''))
}

function readBearerToken(req) {
  const header = req.headers.get('Authorization') || ''
  const match = header.match(/^Bearer\s+(.+)$/i)
  if (!match) throw new AuthError('A signed-in Microsoft session is required')
  return match[1]
}

function discoveryUrl(tenantId, tokenVersion) {
  const suffix = tokenVersion === '1.0' ? '' : '/v2.0'
  return `https://login.microsoftonline.com/${tenantId}${suffix}/.well-known/openid-configuration`
}

async function signingKey(tenantId, tokenVersion, keyId) {
  const now = Date.now()
  const cacheKey = `${tenantId}:${tokenVersion === '1.0' ? 'v1' : 'v2'}`
  let cache = jwkCaches.get(cacheKey)
  if (!cache?.keys.has(keyId) || cache.expiresAt <= now) {
    // Microsoft Graph can issue v1 access tokens. Microsoft requires the
    // matching v1 OIDC metadata in that case; the v2 key document can select
    // a different key set and make a valid signature appear invalid.
    const metadataResponse = await fetch(discoveryUrl(tenantId, tokenVersion))
    if (!metadataResponse.ok) throw new AuthError('Could not load Microsoft token metadata', 503, 'identity_unavailable')
    const metadata = await metadataResponse.json()
    const jwksUri = String(metadata.jwks_uri || '')
    if (!jwksUri.startsWith('https://login.microsoftonline.com/')) {
      throw new AuthError('Microsoft token metadata did not contain a trusted key endpoint', 503, 'identity_unavailable')
    }
    const response = await fetch(jwksUri)
    if (!response.ok) throw new AuthError('Could not verify the Microsoft sign-in token', 503, 'identity_unavailable')
    const payload = await response.json()
    const keys = new Map((payload.keys || []).map((key) => [key.kid, key]))
    cache = { keys, expiresAt: now + JWK_CACHE_MS }
    jwkCaches.set(cacheKey, cache)
  }
  const key = cache.keys.get(keyId)
  if (!key) throw new AuthError('The Microsoft sign-in token uses an unknown signing key', 401, 'invalid_token')
  return crypto.subtle.importKey(
    'jwk',
    key,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  )
}

function validAudience(value) {
  const audiences = Array.isArray(value) ? value : [value]
  return audiences.some((audience) => GRAPH_AUDIENCES.has(String(audience || '')))
}

export async function verifyEntraRequest(req, env) {
  if (!env.MS_TENANT_ID || !env.MS_CLIENT_ID) {
    throw new AuthError('Worker identity validation is not configured', 503, 'identity_not_configured')
  }

  const token = readBearerToken(req)
  const [encodedHeader, encodedPayload, encodedSignature, ...extra] = token.split('.')
  if (!encodedHeader || !encodedPayload || !encodedSignature || extra.length) {
    throw new AuthError('Invalid Microsoft sign-in token', 401, 'invalid_token')
  }

  let header
  let claims
  try {
    header = decodeSegment(encodedHeader)
    claims = decodeSegment(encodedPayload)
  } catch {
    throw new AuthError('Invalid Microsoft sign-in token', 401, 'invalid_token')
  }

  if (header.alg !== 'RS256' || !header.kid) throw new AuthError('Unsupported Microsoft sign-in token', 401, 'invalid_token')

  const now = Math.floor(Date.now() / 1000)
  if (claims.tid !== env.MS_TENANT_ID) {
    throw new AuthError('This sign-in token is not from the configured organization', 403, 'wrong_tenant')
  }
  if (!validIssuer(claims.iss, env.MS_TENANT_ID)) {
    throw new AuthError('This sign-in token has an unrecognized Microsoft issuer', 403, 'wrong_issuer')
  }
  if (!validAudience(claims.aud)) throw new AuthError('This sign-in token is not valid for Microsoft Graph', 403, 'wrong_audience')
  if (!Number.isFinite(claims.exp) || claims.exp < now - CLOCK_SKEW_SECONDS || (claims.nbf && claims.nbf > now + CLOCK_SKEW_SECONDS)) {
    throw new AuthError('Microsoft sign-in token has expired', 401, 'expired_token')
  }
  if ((claims.azp || claims.appid) !== env.MS_CLIENT_ID) {
    throw new AuthError('This sign-in token was issued to a different application', 403, 'wrong_client')
  }
  if (!String(claims.scp || '').trim()) throw new AuthError('A delegated Microsoft sign-in token is required', 403, 'delegated_token_required')

  const key = await signingKey(env.MS_TENANT_ID, claims.ver, header.kid)
  const data = new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`)
  const signature = Uint8Array.from(atob(encodedSignature.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(encodedSignature.length / 4) * 4, '=')), (char) => char.charCodeAt(0))
  const verified = await crypto.subtle.verify({ name: 'RSASSA-PKCS1-v1_5' }, key, signature, data)
  if (!verified) throw new AuthError('Microsoft sign-in token signature is invalid', 401, 'invalid_token')

  return { userId: claims.oid || claims.sub || '', name: claims.name || '', scopes: String(claims.scp || '').split(' ').filter(Boolean) }
}
