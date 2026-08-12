const TEXT_ENCODER = new TextEncoder()
const TEXT_DECODER = new TextDecoder()
const AAD = TEXT_ENCODER.encode('tag-crm:ebuy-connection:v1')

function bytesToBase64(bytes) {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function base64ToBytes(value) {
  const binary = atob(String(value || '').trim())
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}

function hexToBytes(value) {
  const normalized = String(value || '').trim()
  if (!/^[a-f0-9]{64}$/i.test(normalized)) return null
  return Uint8Array.from(normalized.match(/.{2}/g), (pair) => Number.parseInt(pair, 16))
}

async function encryptionKey(secret) {
  let raw
  try {
    raw = hexToBytes(secret) || base64ToBytes(secret)
  } catch {
    raw = null
  }
  if (raw.byteLength !== 32) {
    const error = new Error('EBUY_CREDENTIAL_ENCRYPTION_KEY must contain exactly 32 bytes')
    error.code = 'ebuy_encryption_key_invalid'
    error.status = 503
    throw error
  }
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
}

export async function encryptEbuySecret(secret, value) {
  if (!secret) {
    const error = new Error('The eBuy credential encryption secret is not configured')
    error.code = 'ebuy_encryption_not_configured'
    error.status = 503
    throw error
  }
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const key = await encryptionKey(secret)
  const plaintext = TEXT_ENCODER.encode(JSON.stringify(value))
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: AAD }, key, plaintext)
  return JSON.stringify({ version: 1, iv: bytesToBase64(iv), data: bytesToBase64(new Uint8Array(encrypted)) })
}

export async function decryptEbuySecret(secret, envelope) {
  if (!envelope) return null
  if (!secret) {
    const error = new Error('The eBuy credential encryption secret is not configured')
    error.code = 'ebuy_encryption_not_configured'
    error.status = 503
    throw error
  }
  let payload
  try {
    payload = JSON.parse(envelope)
    if (payload.version !== 1 || !payload.iv || !payload.data) throw new Error('Unsupported envelope')
    const key = await encryptionKey(secret)
    const decrypted = await crypto.subtle.decrypt({
      name: 'AES-GCM',
      iv: base64ToBytes(payload.iv),
      additionalData: AAD,
    }, key, base64ToBytes(payload.data))
    return JSON.parse(TEXT_DECODER.decode(decrypted))
  } catch (cause) {
    const error = new Error('The saved eBuy connection could not be decrypted')
    error.code = 'ebuy_connection_decryption_failed'
    error.status = 503
    error.cause = cause
    throw error
  }
}

export function maskEbuyUsername(value) {
  const username = String(value || '').trim()
  const [local, domain] = username.split('@')
  if (!domain) return local ? `${local.slice(0, 2)}${'*'.repeat(Math.max(2, local.length - 2))}` : ''
  return `${local.slice(0, 2)}${'*'.repeat(Math.max(2, local.length - 2))}@${domain}`
}
