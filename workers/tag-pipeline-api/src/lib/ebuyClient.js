import { generateTotp } from './ebuyTotp.js'

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
  const explicit = String(info?.requestTypeString || summary.requestTypeString || '').trim().toUpperCase()
  if (explicit) return explicit
  if (info?.sourceSought) return 'RFI'
  return ({ 2: 'RFI', 3: 'RFP' })[Number(info?.requestType)] || 'RFQ'
}

function locationText(address) {
  if (!address) return ''
  return [address.addressName, address.addressLine1, address.addressLine2, address.city, address.state, address.zip, address.countryName || address.country]
    .map((item) => String(item || '').trim()).filter(Boolean).join(', ')
}

export function normalizeLiveEbuyOpportunity(summary, detail, contractNumber) {
  const info = detail?.rfqInfo || summary?.rfq?.rfqInfo || {}
  const props = detail?.rfqProps || summary?.rfq?.rfqProps || {}
  const additional = detail?.rfqAdditionalInfo || summary?.rfq?.rfqAdditionalInfo || {}
  const categories = Array.isArray(detail?.rfqCategories) ? detail.rfqCategories : []
  const addresses = Array.isArray(detail?.rfqAddresses) ? detail.rfqAddresses : []
  const attachments = (Array.isArray(detail?.rfqAttachments) ? detail.rfqAttachments : []).map((attachment) => ({
    id: `${info.rfqId || summary.rfqId}:${attachment.docSeqNum ?? attachment.seqNum ?? attachment.docName}`,
    fileName: String(attachment.docName || 'Attachment'),
    contentType: 'application/octet-stream',
    docPath: String(attachment.docPath || ''),
    sourceUrl: String(attachment.docPath || ''),
    docSeqNum: attachment.docSeqNum ?? attachment.seqNum ?? null,
    postedAt: isoDate(attachment.docSessionDate),
  }))
  const amendments = (Array.isArray(detail?.rfqModifications) ? detail.rfqModifications : []).map((modification) => ({
    id: `${info.rfqId || summary.rfqId}:mod:${modification.versionNumber ?? modification.modificationTime}`,
    label: modification.amendIdentifier || `Modification ${modification.versionNumber ?? ''}`.trim(),
    description: String(modification.modificationNote || ''),
    postedAt: isoDate(modification.modificationTime),
  }))
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
    id: String(info.rfqId || summary.rfqId || ''),
    requestId: String(info.rfqId || summary.rfqId || ''),
    requestType: requestType(info, summary),
    title: String(info.title || summary.title || ''),
    description: String(info.description || ''),
    referenceNumber: String(info.referenceNum || ''),
    buyerAgency: String(props.userAgency || summary.userAgency || additional.ocoAgency || ''),
    buyerDepartment: String(props.userBureau || ''),
    buyerName: String(props.userName || summary.userName || additional.ocoName || ''),
    buyerEmail: String(props.userEmail || summary.userEmail || ''),
    buyerPhone: String(props.userPhone || additional.ocoPhone || ''),
    setAsideType: String(props.setAsideBusinessIndicator || ''),
    contractType: String(additional.contractType || ''),
    awardMethod: String(additional.awardMethod || ''),
    placeOfPerformanceRaw: locationText(detail?.rfqDefaultAddress || addresses.find((item) => item.defaultAddress) || addresses[0]),
    performanceStates: [...new Set(addresses.map((item) => item.state).filter(Boolean))],
    vehicleSources: [...new Set([contractNumber, ...schedules].filter(Boolean))],
    vehicleSins: sins,
    vehiclePairs: [...new Set(categories.map((item) => `${item.schedule || contractNumber}:${item.sin || ''}`.replace(/:$/, '')).filter(Boolean))],
    postedAt: isoDate(info.issueTime ?? summary.issueTime),
    closesAt: isoDate(info.closeTime ?? summary.closeTimeDate ?? summary.closeTime),
    lastScrapedAt: new Date().toISOString(),
    isFollowOn: String(additional.followOnRequirement || '').toLowerCase() === 'yes',
    amendments,
    attachments,
    sourceDetails: { contractNumber, rfqInfo: safeInfo, rfqAdditionalInfo: additional, rfqProps: props, rfqCategories: safeCategories, rfqLineItems: detail?.rfqLineItems || [], rfqAddresses: addresses },
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
  form.append('data', JSON.stringify({ fileName: attachment.fileName, docPath: attachment.docPath, action: 'download' }))
  const response = await request(`${EBUY_API}/rfq/${encodeURIComponent(requestId)}/rfqAttachment/`, {
    method: 'POST', headers: { Accept: '*/*', Authorization: `Bearer ${jwtToken}` }, body: form,
  }, 60_000)
  if (!response.ok) throw connectorError(`GSA eBuy could not download ${attachment.fileName} (${response.status})`, 'ebuy_attachment_download_failed')
  return response
}
