const GRAPH_AUDIENCES = new Set([
  '00000003-0000-0000-c000-000000000000',
  'https://graph.microsoft.com',
  'https://graph.microsoft.com/',
])

const CLOCK_SKEW_SECONDS = 300
const JWK_CACHE_MS = 6 * 60 * 60 * 1000
let jwkCache = { expiresAt: 0, keys: new Map() }

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

function expectedIssuer(tenantId) {
  return `https://login.microsoftonline.com/${tenantId}/v2.0`
}

function readBearerToken(req) {
  const header = req.headers.get('Authorization') || ''
  const match = header.match(/^Bearer\s+(.+)$/i)
  if (!match) throw new AuthError('A signed-in Microsoft session is required')
  return match[1]
}

async function signingKey(tenantId, keyId) {
  const now = Date.now()
  if (!jwkCache.keys.has(keyId) || jwkCache.expiresAt <= now) {
    const response = await fetch(`https://login.microsoftonline.com/${tenantId}/discovery/v2.0/keys`)
    if (!response.ok) throw new AuthError('Could not verify the Microsoft sign-in token', 503, 'identity_unavailable')
    const payload = await response.json()
    const keys = new Map((payload.keys || []).map((key) => [key.kid, key]))
    jwkCache = { keys, expiresAt: now + JWK_CACHE_MS }
  }
  const key = jwkCache.keys.get(keyId)
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
  if (claims.tid !== env.MS_TENANT_ID || claims.iss !== expectedIssuer(env.MS_TENANT_ID)) {
    throw new AuthError('This sign-in token is not from the configured organization', 403, 'wrong_tenant')
  }
  if (!validAudience(claims.aud)) throw new AuthError('This sign-in token is not valid for Microsoft Graph', 403, 'wrong_audience')
  if (!Number.isFinite(claims.exp) || claims.exp < now - CLOCK_SKEW_SECONDS || (claims.nbf && claims.nbf > now + CLOCK_SKEW_SECONDS)) {
    throw new AuthError('Microsoft sign-in token has expired', 401, 'expired_token')
  }
  if ((claims.azp || claims.appid) !== env.MS_CLIENT_ID) {
    throw new AuthError('This sign-in token was issued to a different application', 403, 'wrong_client')
  }
  if (!String(claims.scp || '').trim()) throw new AuthError('A delegated Microsoft sign-in token is required', 403, 'delegated_token_required')

  const key = await signingKey(env.MS_TENANT_ID, header.kid)
  const data = new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`)
  const signature = Uint8Array.from(atob(encodedSignature.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(encodedSignature.length / 4) * 4, '=')), (char) => char.charCodeAt(0))
  const verified = await crypto.subtle.verify({ name: 'RSASSA-PKCS1-v1_5' }, key, signature, data)
  if (!verified) throw new AuthError('Microsoft sign-in token signature is invalid', 401, 'invalid_token')

  return { userId: claims.oid || claims.sub || '', name: claims.name || '', scopes: String(claims.scp || '').split(' ').filter(Boolean) }
}
