const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

function decodeBase32(value) {
  const normalized = String(value || '').toUpperCase().replace(/[\s=-]/g, '')
  if (!normalized || /[^A-Z2-7]/.test(normalized)) {
    const error = new Error('Enter the authenticator setup key shown by FAS ID')
    error.code = 'ebuy_totp_secret_invalid'
    error.status = 400
    throw error
  }
  let bits = ''
  for (const character of normalized) bits += BASE32_ALPHABET.indexOf(character).toString(2).padStart(5, '0')
  const bytes = []
  for (let offset = 0; offset + 8 <= bits.length; offset += 8) bytes.push(Number.parseInt(bits.slice(offset, offset + 8), 2))
  return Uint8Array.from(bytes)
}

export async function generateTotp(secret, timestamp = Date.now(), { period = 30, digits = 6 } = {}) {
  const counter = Math.floor(timestamp / 1000 / period)
  const message = new Uint8Array(8)
  let value = BigInt(counter)
  for (let index = 7; index >= 0; index--) {
    message[index] = Number(value & 0xffn)
    value >>= 8n
  }
  const key = await crypto.subtle.importKey('raw', decodeBase32(secret), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign'])
  const digest = new Uint8Array(await crypto.subtle.sign('HMAC', key, message))
  const offset = digest[digest.length - 1] & 0x0f
  const code = ((digest[offset] & 0x7f) << 24)
    | ((digest[offset + 1] & 0xff) << 16)
    | ((digest[offset + 2] & 0xff) << 8)
    | (digest[offset + 3] & 0xff)
  return String(code % (10 ** digits)).padStart(digits, '0')
}

