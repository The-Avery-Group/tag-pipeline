const GRAPH_AUDIENCES = new Set([
  '00000003-0000-0000-c000-000000000000',
  'https://graph.microsoft.com',
  'https://graph.microsoft.com/',
])

const CLOCK_SKEW_SECONDS = 300
const TOKEN_VALIDATION_CACHE_MS = 5 * 60 * 1000
const tokenValidationCache = new Map()

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

async function tokenFingerprint(token) {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)))
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

async function validateWithMicrosoftGraph(token, claims) {
  const fingerprint = await tokenFingerprint(token)
  const cached = tokenValidationCache.get(fingerprint)
  if (cached && cached.expiresAt > Date.now()) return cached.identity

  // This is a Microsoft Graph access token. Let its intended resource verify
  // its signature, key rollover, audience, and revocation state instead of
  // reimplementing Entra's JWT validation inside the Worker.
  const response = await fetch('https://graph.microsoft.com/v1.0/me?$select=id,displayName,userPrincipalName', {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!response.ok) {
    if ([401, 403].includes(response.status)) {
      throw new AuthError('Microsoft sign-in token is not valid', 401, 'invalid_token')
    }
    throw new AuthError('Microsoft identity verification is temporarily unavailable', 503, 'identity_unavailable')
  }
  const identity = await response.json()
  const tokenExpiry = Number(claims.exp || 0) * 1000
  tokenValidationCache.set(fingerprint, {
    identity,
    expiresAt: Math.min(tokenExpiry, Date.now() + TOKEN_VALIDATION_CACHE_MS),
  })
  return identity
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

  const identity = await validateWithMicrosoftGraph(token, claims)

  return {
    userId: identity.id || claims.oid || claims.sub || '',
    name: identity.displayName || claims.name || '',
    email: identity.userPrincipalName || claims.preferred_username || claims.upn || '',
    scopes: String(claims.scp || '').split(' ').filter(Boolean),
  }
}
