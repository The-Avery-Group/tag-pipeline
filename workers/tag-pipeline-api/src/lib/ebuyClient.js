import { generateTotp } from './ebuyTotp.js'
import { normalizeNoticeType } from './noticeTypes.js'

const EBUY_ORIGIN = 'https://www.ebuy.gsa.gov'
const EBUY_API = `${EBUY_ORIGIN}/ebuy/api/services/ebuyservices`
const OKTA_ORIGIN = 'https://mfalogin.fas.gsa.gov'
const OKTA_ISSUER = `${OKTA_ORIGIN}/oauth2/aus4g6gtt3hndAzZq297`
const SELLER_CLIENT_ID = '0oa55my5bl2HNr9GC297'
const CALLBACK_URL = `${EBUY_ORIGIN}/ebuy/pkce/callback`
const EBUY_APP_URL = `${EBUY_ORIGIN}/ebuy/`

function ebuyBrowserHeaders(referer = EBUY_APP_URL) {
  return {
    Origin: EBUY_ORIGIN,
    Referer: referer,
    'Cache-Control': 'no-cache',
    Pragma: 'no-cache',
  }
}

function fasBrowserHeaders() {
  return { Origin: OKTA_ORIGIN, Referer: `${OKTA_ORIGIN}/` }
}

function connectorError(message, code, status = 502) {
  const error = new Error(message)
  error.code = code
  error.status = status
  return error
}

async function request(url, options = {}, timeoutMs = 25_000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...options, signal: controller.signal })
  } catch (cause) {
    if (cause?.name === 'AbortError') throw connectorError('GSA eBuy did not respond before the connection timed out', 'ebuy_timeout', 504)
    let endpoint = 'unavailable'
    try {
      endpoint = new URL(url).pathname
    } catch {
      // Never log credentials, query parameters, or request bodies.
    }
    console.warn(JSON.stringify({
      level: 'warn',
      event: 'ebuy_request_network_error',
      method: options?.method || 'GET',
      endpoint,
      cause: cause?.name || 'Error',
      message: String(cause?.message || 'Network request failed').slice(0, 300),
    }))
    throw connectorError('GSA eBuy could not be reached', 'ebuy_network_error', 502)
  } finally {
    clearTimeout(timer)
  }
}

async function readJson(response, service) {
  const payload = await response.json().catch(() => null)
  if (!response.ok) {
    const message = payload?.errorSummary || payload?.error?.message || payload?.response?.message
      || `${service} returned ${response.status}`
    throw connectorError(message, response.status === 401 ? 'ebuy_authentication_failed' : 'ebuy_upstream_error', response.status === 401 ? 401 : 502)
  }
  return payload
}

async function postJson(url, body, options = {}) {
  const response = await request(url, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...(options.headers || {}) },
    body: JSON.stringify(body),
  }, options.timeoutMs)
  return readJson(response, options.service || 'GSA eBuy')
}

function requireSuccessfulEbuyResponse(payload, action, acceptsResponse = null) {
  const status = Number(payload?.header?.status)
  const response = payload?.response
  // eBuy uses both service-style `0` and HTTP-style `200` success values
  // across otherwise identical response envelopes. Some seller-login replies
  // use a different envelope status even though the requested contract list
  // is present, so that endpoint also supplies a payload-specific validator.
  const acceptedByPayload = Boolean(response && acceptsResponse?.(response))
  if (!response || (![0, 200].includes(status) && !acceptedByPayload)) {
    throw connectorError(response?.message || `GSA eBuy could not ${action}`, 'ebuy_response_error')
  }
  return response
}

function cleanContracts(response) {
  const infoByNumber = new Map((response?.sellerContractInfoList || []).map((item) => [String(item.contractNumber || ''), item]))
  return [...new Set((response?.sellerEmails || []).map(String).filter(Boolean))].map((contractNumber) => ({
    contractNumber,
    contractVehicle: String(infoByNumber.get(contractNumber)?.contractVehicle || ''),
    companyName: String(infoByNumber.get(contractNumber)?.companyName || ''),
  }))
}

async function createOktaSession(credentials) {
  const primary = await postJson(`${OKTA_ORIGIN}/api/v1/authn`, {
    username: credentials.username,
    password: credentials.password,
    options: { multiOptionalFactorEnroll: false, warnBeforePasswordExpired: true },
  }, { service: 'FAS ID primary authentication', headers: fasBrowserHeaders() })

  if (primary.status === 'SUCCESS' && primary.sessionToken) return primary.sessionToken
  if (!['MFA_REQUIRED', 'MFA_CHALLENGE'].includes(primary.status)) {
    const code = primary.status === 'PASSWORD_EXPIRED' ? 'ebuy_password_expired' : 'ebuy_authentication_action_required'
    throw connectorError(`FAS ID requires account action before TAG CRM can connect (${primary.status || 'unknown status'})`, code, 409)
  }

  const factors = primary?._embedded?.factors || []
  const factor = factors.find((item) => item.factorType === 'token:software:totp')
  if (!factor) {
    throw connectorError(
      'This FAS ID account does not have an authenticator-app factor available. Add one before enabling autonomous synchronization.',
      'ebuy_totp_not_enrolled',
      409,
    )
  }
  const factorId = factor.id
  const stateToken = primary.stateToken
  if (!factorId || !stateToken) throw connectorError('FAS ID did not return a usable authenticator challenge', 'ebuy_mfa_challenge_invalid')

  const passCode = await generateTotp(credentials.totpSecret)
  const verified = await postJson(`${OKTA_ORIGIN}/api/v1/authn/factors/${encodeURIComponent(factorId)}/verify?rememberDevice=true`, {
    stateToken,
    passCode,
  }, { service: 'FAS ID authenticator verification', headers: fasBrowserHeaders() })
  if (verified.status !== 'SUCCESS' || !verified.sessionToken) {
    throw connectorError('The authenticator setup key could not complete FAS ID verification', 'ebuy_totp_verification_failed', 401)
  }
  return verified.sessionToken
}

async function exchangeOktaSession(sessionToken) {
  const pkceResponse = await request(`${EBUY_API}//seller/login/pkce`, {
    headers: { Accept: 'application/json, text/plain, */*', Referer: EBUY_APP_URL, 'Cache-Control': 'no-cache', Pragma: 'no-cache' },
  })
  const pkcePayload = await readJson(pkceResponse, 'GSA eBuy PKCE initialization')
  const pkce = pkcePayload?.response || pkcePayload
  const verifier = pkce?.pkce_code_verifier
  const challenge = pkce?.pkce_code_challenger
  const state = pkce?.pkce_state
  if (!verifier || !challenge || !state) throw connectorError('GSA eBuy did not return a valid PKCE challenge', 'ebuy_pkce_invalid')

  const authorize = new URL(`${OKTA_ISSUER}/v1/authorize`)
  authorize.search = new URLSearchParams({
    response_type: 'code',
    client_id: SELLER_CLIENT_ID,
    state,
    scope: 'openid profile email',
    redirect_uri: CALLBACK_URL,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    sessionToken,
    prompt: 'none',
  }).toString()
  const authorization = await request(authorize, { redirect: 'manual', headers: { Accept: 'text/html', Referer: EBUY_APP_URL } })
  const location = authorization.headers.get('Location')
  if (!location) throw connectorError('FAS ID did not return an eBuy authorization code', 'ebuy_authorization_code_missing')
  const callback = new URL(location, OKTA_ORIGIN)
  const code = callback.searchParams.get('code')
  if (!code || callback.searchParams.get('state') !== state) {
    throw connectorError('FAS ID returned an invalid eBuy authorization response', 'ebuy_authorization_response_invalid')
  }

  const tokenResponse = await request(`${OKTA_ISSUER}/v1/token`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      Origin: EBUY_ORIGIN,
      Referer: EBUY_APP_URL,
      'Cache-Control': 'no-cache',
      Pragma: 'no-cache',
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code', code, client_id: SELLER_CLIENT_ID,
      redirect_uri: CALLBACK_URL, code_verifier: verifier,
    }),
  })
  const token = await readJson(tokenResponse, 'FAS ID token exchange')
  if (!token.access_token) throw connectorError('FAS ID did not return an eBuy access token', 'ebuy_access_token_missing')
  return token
}

export async function authenticateEbuyAccount(credentials) {
  if (!String(credentials?.username || '').trim() || !String(credentials?.password || '') || !String(credentials?.totpSecret || '').trim()) {
    throw connectorError('Username, password, and authenticator setup key are required', 'ebuy_credentials_incomplete', 400)
  }
  const sessionToken = await createOktaSession(credentials)
  const token = await exchangeOktaSession(sessionToken)
  const login = await postJson(`${EBUY_API}//seller/oktalogin/`, { oktatoken: token.access_token, token: '' }, {
    service: 'GSA eBuy seller login',
    headers: { ...ebuyBrowserHeaders(CALLBACK_URL), 'Content-Type': 'text/plain' },
  })
  const loginResponse = requireSuccessfulEbuyResponse(
    login,
    'load seller contracts',
    (response) => Array.isArray(response.sellerEmails),
  )
  const contracts = cleanContracts(loginResponse)
  if (!contracts.length) throw connectorError('No active seller contracts were returned for this eBuy account', 'ebuy_no_contracts', 409)
  return {
    accessToken: token.access_token,
    expiresAt: new Date(Date.now() + Math.max(60, Number(token.expires_in || 3600) - 120) * 1000).toISOString(),
    contracts,
  }
}

export function isEbuySessionFresh(session, now = Date.now()) {
  const expiry = session?.expiresAt ? new Date(session.expiresAt).getTime() : 0
  return Boolean(session?.accessToken && Number.isFinite(expiry) && expiry > now + 60_000)
}

export async function getEbuyContractToken(accessToken, contractNumber) {
  const response = await postJson(`${EBUY_API}//seller/getuser`, {
    contractnumber: contractNumber,
    password: null,
    oktatoken: accessToken,
  }, {
    service: 'GSA eBuy seller contract selection',
    headers: { ...ebuyBrowserHeaders(CALLBACK_URL), 'Content-Type': 'text/plain' },
  })
  const login = requireSuccessfulEbuyResponse(response, 'select a seller contract')
  if (![1, 2, 4].includes(Number(login.rc)) || !login.token) {
    throw connectorError(login.message || `Contract ${contractNumber} could not be selected`, 'ebuy_contract_selection_failed', 409)
  }
  return login.token
}

async function getEbuyJson(path, jwtToken) {
  const response = await request(`${EBUY_API}//${path.replace(/^\//, '')}`, {
    headers: {
      Accept: 'application/json', Authorization: `Bearer ${jwtToken}`,
      Referer: EBUY_APP_URL,
      'Cache-Control': 'no-cache', Pragma: 'no-cache', Expires: '0',
    },
  })
  return requireSuccessfulEbuyResponse(await readJson(response, 'GSA eBuy'), 'load opportunity data')
}

export async function listActiveEbuyOpportunities(contractNumber, jwtToken) {
  const response = await getEbuyJson(`seller/activerfqs/${encodeURIComponent(contractNumber)}`, jwtToken)
  return Array.isArray(response?.[contractNumber]) ? response[contractNumber] : []
}

export async function getEbuyOpportunityDetail(requestId, contractNumber, jwtToken) {
  return getEbuyJson(`seller/rfq/${encodeURIComponent(requestId)}/${encodeURIComponent(contractNumber)}`, jwtToken)
}

function isoDate(value) {
  if (value == null || value === '') return null
  const numeric = typeof value === 'number' || /^\d+$/.test(String(value)) ? Number(value) : null
  const date = numeric != null ? new Date(numeric) : new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

function requestType(info, summary = {}) {
  const explicit = normalizeNoticeType(info?.requestTypeString || summary.requestTypeString)
  const titleType = normalizeNoticeType(info?.title || summary.title)
  // MRAS records can retain an RFI-prefixed eBuy Request ID. Prefer the
  // specific source label/title before falling back to that identifier.
  if (explicit === 'MRAS' || titleType === 'MRAS') return 'MRAS'
  if (explicit) return explicit
  const requestId = String(info?.rfqId || summary?.rfqId || summary?.requestId || '').trim().toUpperCase()
  const idType = ['RFI', 'RFQ', 'RFP'].find((type) => requestId.startsWith(type))
  if (idType) return idType
  if (info?.sourceSought) return 'RFI'
  return ({ 2: 'RFI', 3: 'RFP' })[Number(info?.requestType)] || 'RFQ'
}

function locationText(address) {
  if (!address) return ''
  return [address.addressName, address.addressLine1, address.addressLine2, address.city, address.state, address.zip, address.countryName || address.country]
    .map((item) => String(item || '').trim()).filter(Boolean).join(', ')
}

const DOCUMENT_EXTENSION = 'pdf|docx?|xlsx?|pptx?|txt|rtf|csv|zip|7z|xml|json|jpg|jpeg|png|gif|tiff?'
const DOCUMENT_URL_RE = new RegExp(`(?:https?:\\/\\/[^\\s<>"']+|\\/ebuy_upload\\/[^\\s<>"']+|\\/[^\\s<>"']+)\\.(?:${DOCUMENT_EXTENSION})(?:[?#][^\\s<>"']*)?`, 'gi')
const DOCUMENT_NAME_RE = new RegExp(`(?:^|[\\s("'])(([\\w][\\w .,&'()+-]{0,100})\\.(?:${DOCUMENT_EXTENSION}))(?=$|[\\s)"',;:])`, 'gi')

function sourceRecord(value) {
  return value?.rfq && typeof value.rfq === 'object' ? value.rfq : value || {}
}

function sourceLabel(value) {
  if (value == null) return ''
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
  if (typeof value === 'string' || typeof value === 'number') return String(value).trim()
  if (typeof value !== 'object') return ''
  for (const key of ['description', 'name', 'label', 'text', 'value', 'code']) {
    const label = sourceLabel(value[key])
    if (label) return label
  }
  return ''
}

function valuesForSourceKeys(root, keyPattern, maxDepth = 5) {
  const values = []
  const visited = new WeakSet()
  const visit = (value, depth = 0) => {
    if (!value || typeof value !== 'object' || depth > maxDepth || visited.has(value)) return
    visited.add(value)
    if (Array.isArray(value)) {
      value.forEach((item) => visit(item, depth + 1))
      return
    }
    for (const [key, entry] of Object.entries(value)) {
      if (/password|token|session|vendor/i.test(key)) continue
      if (keyPattern.test(key)) {
        const label = sourceLabel(entry)
        if (label) values.push({ key, label })
      }
      if (entry && typeof entry === 'object') visit(entry, depth + 1)
    }
  }
  visit(root)
  return values
}

function normalizeSetAside(value) {
  const label = sourceLabel(value)
  if (!label) return ''
  const compact = label.toUpperCase().replace(/[^A-Z0-9]+/g, '')
  if (['Y', 'YES', 'TRUE', '1', 'SB', 'SBA', 'SMALLBUSINESS'].includes(compact)) return 'Small Business Set-Aside'
  if (['N', 'NO', 'FALSE', '0', 'NONE', 'UNRESTRICTED', 'FULLANDOPEN'].includes(compact)) return 'Unrestricted'
  const known = [
    [/8\(?A\)?|EIGHTA/, '8(a) Set-Aside'],
    [/SDVOSB|SERVICEDISABLEDVETERAN/, 'Service-Disabled Veteran-Owned Small Business Set-Aside'],
    [/EDWOSB/, 'Economically Disadvantaged Women-Owned Small Business Set-Aside'],
    [/WOSB|WOMENOWNED/, 'Women-Owned Small Business Set-Aside'],
    [/HUBZONE/, 'HUBZone Set-Aside'],
    [/VOSB|VETERANOWNED/, 'Veteran-Owned Small Business Set-Aside'],
  ]
  return known.find(([pattern]) => pattern.test(compact))?.[1] || label
}

function resolveSetAside(...sources) {
  const preferred = []
  for (const source of sources) {
    if (!source || typeof source !== 'object') continue
    for (const key of [
      'setAsideTypeDescription', 'setAsideDescription', 'setAsideType', 'setAside',
      'smallBusinessSetAside', 'setAsideBusinessIndicator',
    ]) {
      const label = sourceLabel(source[key])
      if (label) preferred.push({ key, label })
    }
  }
  const discovered = sources.flatMap((source) => valuesForSourceKeys(source, /set.?aside|small.?business.*indicator|business.*set.?aside/i))
  const candidates = [...preferred, ...discovered]
  candidates.sort((left, right) => {
    const score = (candidate) => {
      const descriptive = /description|type|name/i.test(candidate.key) ? 20 : 0
      const meaningful = /[A-Za-z]{3}/.test(candidate.label) ? 10 : 0
      return descriptive + meaningful + Math.min(candidate.label.length, 20)
    }
    return score(right) - score(left)
  })
  return normalizeSetAside(candidates[0]?.label)
}

function attachmentFileName(attachment, fallback = 'Attachment') {
  const explicit = String(attachment?.docName || attachment?.fileName || attachment?.originalFileName
    || attachment?.documentName || attachment?.name || attachment?.title || '').trim()
  if (explicit) return explicit
  const path = String(attachment?.docPath || attachment?.downloadUrl || attachment?.url || attachment?.href || attachment?.path || '').trim()
  try {
    return decodeURIComponent(new URL(path, EBUY_ORIGIN).pathname.split('/').filter(Boolean).at(-1) || fallback)
  } catch {
    return fallback
  }
}

function attachmentPath(attachment) {
  return String(attachment?.docPath || attachment?.documentPath || attachment?.filePath
    || attachment?.downloadUrl || attachment?.url || attachment?.href || attachment?.path || '').trim()
}

function collectAttachmentDtos(...roots) {
  const found = []
  const add = (attachment, amendmentId = '') => {
    if (typeof attachment === 'string') attachment = { docPath: attachment }
    if (!attachment || typeof attachment !== 'object') return
    const docPath = attachmentPath(attachment)
    const fileName = attachmentFileName(attachment)
    if (!docPath && fileName === 'Attachment') return
    found.push({ ...attachment, docPath, docName: fileName, amendmentId: String(amendmentId || attachment.amendmentId || '').trim() })
  }
  const visited = new WeakSet()
  const visit = (value, context = '', amendmentId = '', depth = 0) => {
    if (value == null || depth > 7) return
    if (typeof value === 'string') {
      // A filename property is metadata for its parent attachment, not a
      // second downloadable file. Only collect standalone strings when they
      // contain an actual source path or URL.
      if (/attach|document|file/i.test(context) && (/^https?:\/\//i.test(value) || value.startsWith('/'))) add(value, amendmentId)
      return
    }
    if (typeof value !== 'object' || visited.has(value)) return
    visited.add(value)
    if (Array.isArray(value)) {
      value.forEach((entry) => visit(entry, context, amendmentId, depth + 1))
      return
    }
    const nextAmendmentId = String(value.amendIdentifier || value.versionNumber || value.amendmentId || amendmentId || '').trim()
    const path = attachmentPath(value)
    const name = attachmentFileName(value, '')
    const attachmentContext = /attach|document|file/i.test(context)
    const attachmentIdentity = value.docSeqNum != null || value.seqNum != null || value.documentId != null || value.attachmentId != null
    if ((path || name) && (attachmentContext || attachmentIdentity || /\.(?:pdf|docx?|xlsx?|pptx?|txt|rtf|csv|zip|7z|xml|json|jpe?g|png|gif|tiff?)$/i.test(name))) add(value, nextAmendmentId)
    for (const [key, entry] of Object.entries(value)) {
      if (/password|token|session|rfqVendors/i.test(key)) continue
      visit(entry, key, nextAmendmentId, depth + 1)
    }
  }
  roots.forEach((root) => visit(root))
  return found
}

function descriptionAttachmentEvidence(description, attachments) {
  const text = String(description || '')
  const mentioned = /\battach(?:ed|ment|ments)?\b/i.test(text)
  const linked = [...text.matchAll(DOCUMENT_URL_RE)].map((match) => match[0].replace(/[.,;)]+$/, ''))
  const linkedAttachments = linked.map((docPath) => ({ docPath, docName: attachmentFileName({ docPath }) }))
  const knownNames = new Set([...attachments, ...linkedAttachments].map((attachment) => attachmentFileName(attachment).toLowerCase()))
  const missing = [...text.matchAll(DOCUMENT_NAME_RE)]
    .map((match) => String(match[1] || '').trim()
      .replace(/^(?:please\s+)?(?:see|review|open)\s+(?:the\s+)?(?:attached\s+)?/i, '')
      .replace(/^(?:the\s+)?attached\s+/i, '')
      .trim())
    .filter((name, index, values) => name && !knownNames.has(name.toLowerCase()) && values.findIndex((value) => value.toLowerCase() === name.toLowerCase()) === index)
  return { mentioned, linkedAttachments, missing }
}

function normalizeAttachments(roots, requestId, description) {
  const source = collectAttachmentDtos(...roots)
  const evidence = descriptionAttachmentEvidence(description, source)
  const deduped = new Map()
  for (const attachment of [...source, ...evidence.linkedAttachments]) {
    const fileName = attachmentFileName(attachment)
    const docPath = attachmentPath(attachment)
    const amendmentId = String(attachment.amendmentId || '').trim()
    const identity = String(attachment.docSeqNum ?? attachment.seqNum ?? '').trim()
      || docPath.toLowerCase()
      || `${amendmentId}:${fileName}`.toLowerCase()
    if (!identity || deduped.has(identity)) continue
    deduped.set(identity, {
      id: `${requestId}:${identity}`,
      fileName,
      contentType: 'application/octet-stream',
      docPath,
      sourceUrl: docPath,
      amendmentId,
      docSeqNum: attachment.docSeqNum ?? attachment.seqNum ?? null,
      docType: attachment.docType ?? null,
      docSessionId: attachment.docSessionId ?? null,
      docSessionDate: attachment.docSessionDate ?? null,
      seqNum: attachment.seqNum ?? null,
      postedAt: isoDate(attachment.docSessionDate),
    })
  }
  return {
    attachments: [...deduped.values()],
    references: {
      mentioned: evidence.mentioned,
      missing: evidence.missing,
    },
  }
}

export function normalizeLiveEbuyOpportunity(summary, detail, contractNumber) {
  const summaryDetail = sourceRecord(summary)
  const detailRecord = sourceRecord(detail)
  const info = { ...(summaryDetail.rfqInfo || {}), ...(detailRecord.rfqInfo || {}) }
  const props = { ...(summaryDetail.rfqProps || {}), ...(detailRecord.rfqProps || {}) }
  const additional = { ...(summaryDetail.rfqAdditionalInfo || {}), ...(detailRecord.rfqAdditionalInfo || {}) }
  const categories = [...(Array.isArray(summaryDetail.rfqCategories) ? summaryDetail.rfqCategories : []), ...(Array.isArray(detailRecord.rfqCategories) ? detailRecord.rfqCategories : [])]
  const addresses = [...(Array.isArray(summaryDetail.rfqAddresses) ? summaryDetail.rfqAddresses : []), ...(Array.isArray(detailRecord.rfqAddresses) ? detailRecord.rfqAddresses : [])]
  const description = String(info.description || detailRecord.description || summaryDetail.description || summary.description || '')
  const requestId = info.rfqId || summaryDetail.rfqId || summary.rfqId || summary.requestId || ''
  const normalizedAttachmentData = normalizeAttachments([summary, summaryDetail, detail, detailRecord], requestId, description)
  const modificationSources = [summaryDetail, detailRecord].flatMap((source) => [
    ...(Array.isArray(source?.rfqModifications) ? source.rfqModifications : []),
    ...(Array.isArray(source?.rfqAmendments) ? source.rfqAmendments : []),
    ...(Array.isArray(source?.amendments) ? source.amendments : []),
  ])
  const seenAmendments = new Set()
  const amendments = modificationSources.map((modification) => ({
    id: `${requestId}:mod:${modification.versionNumber ?? modification.modificationTime}`,
    label: modification.amendIdentifier || `Modification ${modification.versionNumber ?? ''}`.trim(),
    description: String(modification.modificationNote || ''),
    postedAt: isoDate(modification.modificationTime),
  })).filter((amendment) => {
    const key = `${amendment.id}|${amendment.label}|${amendment.postedAt || ''}`
    if (seenAmendments.has(key)) return false
    seenAmendments.add(key)
    return true
  })
  const schedules = [...new Set(categories.map((item) => item.schedule).filter(Boolean))]
  const sins = [...new Set(categories.map((item) => item.sin).filter(Boolean))]
  const safeInfo = { ...info }
  delete safeInfo.rfqPassword
  const safeCategories = categories.map((item) => {
    const category = { ...item }
    delete category.rfqVendors
    return category
  })
  return {
    id: String(requestId),
    requestId: String(requestId),
    requestType: requestType(info, summary),
    title: String(info.title || detailRecord.title || summaryDetail.title || summary.title || ''),
    description,
    referenceNumber: String(info.referenceNum || info.referenceNumber || additional.referenceNumber || detailRecord.referenceNumber || summaryDetail.referenceNumber || summary.referenceNumber || ''),
    // eBuy calls the top-level department `userAgency` and the subordinate
    // buying organization `userBureau`. Keep the CRM's Department/Agency
    // meaning consistent with SAM instead of exposing those source labels
    // literally. Some records do not include a bureau; in that case the
    // department remains the best available agency label as well.
    buyerAgency: String(props.userBureau || additional.ocoAgency || props.userAgency || summary.userAgency || ''),
    buyerDepartment: String(props.userAgency || summary.userAgency || additional.ocoAgency || ''),
    buyerName: String(props.userName || summary.userName || additional.ocoName || ''),
    buyerEmail: String(props.userEmail || additional.ocoEmail || detailRecord.userEmail || summaryDetail.userEmail || summary.userEmail || ''),
    buyerPhone: String(props.userPhone || additional.ocoPhone || detailRecord.userPhone || summaryDetail.userPhone || summary.userPhone || ''),
    setAsideType: resolveSetAside(info, props, additional, detailRecord, summaryDetail, summary),
    contractType: String(additional.contractType || props.contractType || info.contractType || ''),
    awardMethod: String(additional.awardMethod || props.awardMethod || info.awardMethod || ''),
    placeOfPerformanceRaw: locationText(detailRecord.rfqDefaultAddress || summaryDetail.rfqDefaultAddress || addresses.find((item) => item.defaultAddress) || addresses[0]),
    performanceStates: [...new Set(addresses.map((item) => item.state).filter(Boolean))],
    vehicleSources: [...new Set([contractNumber, ...schedules].filter(Boolean))],
    vehicleSins: sins,
    vehiclePairs: [...new Set(categories.map((item) => `${item.schedule || contractNumber}:${item.sin || ''}`.replace(/:$/, '')).filter(Boolean))],
    postedAt: isoDate(info.issueTime ?? summary.issueTime),
    closesAt: isoDate(info.closeTime ?? summary.closeTimeDate ?? summary.closeTime),
    lastScrapedAt: new Date().toISOString(),
    isFollowOn: String(additional.followOnRequirement || '').toLowerCase() === 'yes',
    amendments,
    attachments: normalizedAttachmentData.attachments,
    attachmentReferences: normalizedAttachmentData.references,
    sourceDetails: { contractNumber, rfqInfo: safeInfo, rfqAdditionalInfo: additional, rfqProps: props, rfqCategories: safeCategories, rfqLineItems: detailRecord.rfqLineItems || summaryDetail.rfqLineItems || [], rfqAddresses: addresses },
  }
}

export async function downloadEbuyAttachment(requestId, attachment, jwtToken) {
  if (!attachment?.docPath) throw connectorError('The eBuy attachment does not include a document path', 'ebuy_attachment_path_missing', 422)
  if (/^https:\/\//i.test(attachment.docPath)) {
    const host = new URL(attachment.docPath).hostname.toLowerCase()
    if (!(host.endsWith('.gov') || host.endsWith('.gsa.gov'))) {
      throw connectorError('The external attachment host is not approved for automatic archiving', 'ebuy_attachment_host_not_allowed', 422)
    }
    return request(attachment.docPath, { headers: { Accept: '*/*' } }, 60_000)
  }
  const form = new FormData()
  // This endpoint does not accept the attachment DTO returned by the detail
  // service. The official eBuy client sends a small download command instead.
  // Keep this shape aligned with RfqHelperService.downloadRfqFile.
  form.append('data', JSON.stringify({
    fileName: attachment.fileName,
    docPath: attachment.docPath,
    action: 'download',
  }))
  const response = await request(`${EBUY_API}/rfq/${encodeURIComponent(requestId)}/rfqAttachment/`, {
    method: 'POST',
    headers: {
      Accept: 'application/json, text/plain, */*',
      ...ebuyBrowserHeaders(`${EBUY_ORIGIN}/ebuy/seller/prepare-quote/${encodeURIComponent(requestId)}`),
      Authorization: `Bearer ${jwtToken}`,
      Expires: '0',
      'If-Modified-Since': '0',
    },
    body: form,
  }, 60_000)
  const contentType = String(response.headers.get('Content-Type') || '').toLowerCase()
  if (response.ok && !contentType.includes('application/json')) return response
  const authenticationFailure = [401, 403].includes(response.status)

  const payload = contentType.includes('application/json') ? await response.json().catch(() => null) : null
  const upstreamMessage = payload?.response?.message || payload?.message
    || (response.ok
      ? `GSA eBuy did not return the file ${attachment.fileName}`
      : `GSA eBuy could not download ${attachment.fileName} (${response.status})`)

  // Some eBuy document records return an empty JSON envelope from the normal
  // attachment endpoint even though their protected upload path is valid.
  // Retry that first-party path with the same contract token before marking it
  // unavailable. The origin and path checks prevent this from becoming a
  // general-purpose server-side fetch.
  const directUrl = new URL(attachment.docPath, EBUY_ORIGIN)
  if (directUrl.origin === EBUY_ORIGIN && directUrl.pathname.startsWith('/ebuy_upload/')) {
    const direct = await request(directUrl.toString(), {
      headers: {
        Accept: '*/*',
        ...ebuyBrowserHeaders(`${EBUY_ORIGIN}/ebuy/seller/prepare-quote/${encodeURIComponent(requestId)}`),
        Authorization: `Bearer ${jwtToken}`,
        Expires: '0',
        'If-Modified-Since': '0',
      },
    }, 60_000)
    const directType = String(direct.headers.get('Content-Type') || '').toLowerCase()
    if (direct.ok && !directType.includes('application/json') && Number(direct.headers.get('Content-Length') || 1) !== 0) return direct
    if ([401, 403].includes(direct.status)) {
      throw connectorError(`GSA eBuy could not download ${attachment.fileName} (${direct.status})`, 'ebuy_authentication_failed', 401)
    }
  }

  if (authenticationFailure) {
    throw connectorError(`GSA eBuy could not download ${attachment.fileName} (${response.status})`, 'ebuy_authentication_failed', 401)
  }

  throw connectorError(upstreamMessage, 'ebuy_attachment_download_failed')
}
