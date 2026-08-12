import { authenticateEbuyAccount, isEbuySessionFresh } from './ebuyClient.js'
import { decryptEbuySecret, encryptEbuySecret, maskEbuyUsername } from './ebuyCrypto.js'
import {
  deleteEbuyConnection,
  getEbuyConnectionRecord,
  getEbuyConnectionStatus,
  recordEbuyConnectionResult,
  saveEbuyConnection,
  updateEbuyConnectionSession,
} from './ebuyRepository.js'

function requireConnectionDependencies(env) {
  if (!env.EBUY_DB) {
    const error = new Error('The eBuy archive database is not configured')
    error.code = 'ebuy_storage_not_configured'
    error.status = 503
    throw error
  }
  if (!env.EBUY_CREDENTIAL_ENCRYPTION_KEY) {
    const error = new Error('Add the EBUY_CREDENTIAL_ENCRYPTION_KEY Worker secret before connecting eBuy')
    error.code = 'ebuy_encryption_not_configured'
    error.status = 503
    throw error
  }
}

function privateCredentials(input) {
  return {
    username: String(input?.username || '').trim(),
    password: String(input?.password || ''),
    totpSecret: String(input?.totpSecret || '').trim().replace(/\s+/g, ''),
  }
}

export async function connectEbuyAccount(env, input, connectedBy = '') {
  requireConnectionDependencies(env)
  const credentials = privateCredentials(input)
  const session = await authenticateEbuyAccount(credentials)
  const [credentialsEncrypted, sessionEncrypted] = await Promise.all([
    encryptEbuySecret(env.EBUY_CREDENTIAL_ENCRYPTION_KEY, credentials),
    encryptEbuySecret(env.EBUY_CREDENTIAL_ENCRYPTION_KEY, session),
  ])
  await saveEbuyConnection(env.EBUY_DB, {
    usernameMasked: maskEbuyUsername(credentials.username),
    credentialsEncrypted,
    sessionEncrypted,
    contracts: session.contracts,
    connectedBy,
  })
  return getEbuyConnectionStatus(env.EBUY_DB, true)
}

export async function disconnectEbuyAccount(env) {
  if (!env.EBUY_DB) return
  await deleteEbuyConnection(env.EBUY_DB)
}

export async function getEbuyLiveSession(env, { force = false } = {}) {
  requireConnectionDependencies(env)
  const row = await getEbuyConnectionRecord(env.EBUY_DB)
  if (!row) {
    const error = new Error('Connect the company GSA eBuy account in Settings first')
    error.code = 'ebuy_not_connected'
    error.status = 409
    throw error
  }
  const session = await decryptEbuySecret(env.EBUY_CREDENTIAL_ENCRYPTION_KEY, row.session_encrypted)
  if (!force && isEbuySessionFresh(session)) return session

  try {
    const credentials = await decryptEbuySecret(env.EBUY_CREDENTIAL_ENCRYPTION_KEY, row.credentials_encrypted)
    const refreshed = await authenticateEbuyAccount(credentials)
    const encrypted = await encryptEbuySecret(env.EBUY_CREDENTIAL_ENCRYPTION_KEY, refreshed)
    await updateEbuyConnectionSession(env.EBUY_DB, encrypted, refreshed.contracts)
    return refreshed
  } catch (error) {
    await recordEbuyConnectionResult(env.EBUY_DB, { ok: false, code: error.code || 'ebuy_authentication_failed', message: error.message })
    throw error
  }
}

export async function testStoredEbuyConnection(env) {
  const session = await getEbuyLiveSession(env, { force: true })
  await recordEbuyConnectionResult(env.EBUY_DB, { ok: true })
  return { contracts: session.contracts, connection: await getEbuyConnectionStatus(env.EBUY_DB, true) }
}

