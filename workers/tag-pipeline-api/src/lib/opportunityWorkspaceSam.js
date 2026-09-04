import { fetchSAMStructuredResources, isSAMResourceDownloadUrl } from './samOpportunityDetail.js'

const PORTAL_HTML_LIMIT = 5 * 1024 * 1024
const PORTAL_FILE_MARKER = 'tag-portal-file'
const PORTAL_ISSUE_MARKER = 'tag-portal-issue'
const SUPPORTED_FILE_EXTENSION = /\.(?:bmp|csv|docm?|docx|dotm?|dotx|gif|htm|html|jpe?g|json|msg|odt|pdf|png|potm?|potx|ppam|ppsm?|ppsx|pptm?|pptx|rtf|sldm|sldx|thmx|tiff?|txt|xlsb|xlsm?|xlsx|xltm|xltx|xml|xps|zip)$/i

function clean(value) {
  return String(value ?? '').trim()
}

function decodeHtml(value) {
  const named = { amp: '&', apos: "'", gt: '>', lt: '<', nbsp: ' ', quot: '"' }
  return String(value || '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity) => {
    if (entity[0] !== '#') return named[entity.toLowerCase()] ?? match
    const hex = entity[1]?.toLowerCase() === 'x'
    const codePoint = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10)
    return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match
  })
}

function textFromHtml(value) {
  return decodeHtml(String(value || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ')).trim()
}

function attribute(tag, name) {
  const match = String(tag || '').match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i'))
  return decodeHtml(match?.[1] ?? match?.[2] ?? '')
}

function portalProvider(value) {
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:') return ''
    const hostname = url.hostname.toLowerCase().replace(/^www\./, '')
    if (hostname === 'fedconnect.net' || hostname.endsWith('.fedconnect.net')) return 'fedconnect'
    if (hostname === 'piee.eb.mil' || hostname.endsWith('.piee.eb.mil')) return 'piee'
  } catch { /* unsupported URL */ }
  return ''
}

export function isSupportedPortalOpportunityUrl(value) {
  try {
    const url = new URL(value)
    const provider = portalProvider(url)
    if (provider === 'fedconnect') return Boolean(url.searchParams.get('doc') || url.searchParams.get('opportunityid'))
    if (provider === 'piee') {
      return /\/sol\/xhtml\/unauth\/search\/oppMgmtLink\.xhtml$/i.test(url.pathname) &&
        Boolean(url.searchParams.get('noticeId') || url.searchParams.get('solNo'))
    }
  } catch { /* invalid URL */ }
  return false
}

function portalSourceUrl(portalUrl, metadata, issue = false) {
  const url = new URL(portalUrl)
  const params = new URLSearchParams()
  Object.entries(metadata).forEach(([key, value]) => {
    if (value !== undefined && value !== null && clean(value)) params.set(key, clean(value))
  })
  url.hash = `${issue ? PORTAL_ISSUE_MARKER : PORTAL_FILE_MARKER}=${encodeURIComponent(params.toString())}`
  return url.toString()
}

export function portalSourceMetadata(value) {
  try {
    const url = new URL(value)
    const hostProvider = portalProvider(url)
    if (!hostProvider) return null
    const hash = url.hash.slice(1)
    const issue = hash.startsWith(`${PORTAL_ISSUE_MARKER}=`)
    const file = hash.startsWith(`${PORTAL_FILE_MARKER}=`)
    if (!issue && !file) return null
    const encoded = hash.slice(hash.indexOf('=') + 1)
    const params = new URLSearchParams(decodeURIComponent(encoded))
    const encodedProvider = params.get('provider') || ''
    if (encodedProvider && encodedProvider !== hostProvider) return null
    url.hash = ''
    return {
      portalUrl: url.toString(),
      issue,
      provider: hostProvider,
      id: params.get('id') || '',
      target: params.get('target') || '',
      name: params.get('name') || '',
      message: params.get('message') || '',
    }
  } catch {
    return null
  }
}

export function attachmentSourceName(sourceUrl, fallback = 'SAM attachment') {
  return portalSourceMetadata(sourceUrl)?.name || fallback
}

export function portalSourceScope(sourceUrl) {
  const metadata = portalSourceMetadata(sourceUrl)
  return metadata ? `${metadata.provider}|${metadata.portalUrl}` : ''
}

export function stablePortalSourceSignature(sourceUrl) {
  const metadata = portalSourceMetadata(sourceUrl)
  return metadata && !metadata.issue
    ? `${metadata.provider}|${metadata.id}|${metadata.name}`
    : ''
}

function setCookies(response, jar) {
  const values = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : [response.headers.get('Set-Cookie')].filter(Boolean)
  values.flatMap((value) => String(value).split(/,(?=\s*[^;,=\s]+=[^;,]+)/)).forEach((value) => {
    const pair = value.split(';', 1)[0]
    const index = pair.indexOf('=')
    if (index > 0) jar.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim())
  })
}

function cookieHeader(jar) {
  return [...jar.entries()].map(([name, value]) => `${name}=${value}`).join('; ')
}

function samePortalProvider(expected, value) {
  return portalProvider(value) === expected
}

async function portalFetch(url, { jar = new Map(), method = 'GET', headers = {}, body = null, redirects = 5 } = {}) {
  const provider = portalProvider(url)
  if (!provider) throw new Error('Unsupported opportunity portal')
  let current = new URL(url)
  let requestMethod = method
  let requestBody = body
  for (let redirect = 0; redirect <= redirects; redirect += 1) {
    const response = await fetch(current, {
      method: requestMethod,
      body: requestBody,
      redirect: 'manual',
      headers: {
        Accept: 'text/html,application/xhtml+xml,application/pdf,application/octet-stream,*/*',
        'User-Agent': 'TAG-CRM-Public-Opportunity-Archiver/1.0',
        ...(cookieHeader(jar) ? { Cookie: cookieHeader(jar) } : {}),
        ...headers,
      },
    })
    setCookies(response, jar)
    const location = response.headers.get('Location')
    if (![301, 302, 303, 307, 308].includes(response.status) || !location) return { response, jar, url: current.toString() }
    if (redirect === redirects) throw new Error(`${provider === 'piee' ? 'PIEE' : 'FedConnect'} redirected too many times`)
    const next = new URL(location, current)
    if (!samePortalProvider(provider, next)) throw new Error('Opportunity portal redirected outside its approved host')
    await response.body?.cancel().catch(() => {})
    if ([301, 302, 303].includes(response.status) && requestMethod !== 'GET') {
      requestMethod = 'GET'
      requestBody = null
    }
    current = next
  }
  throw new Error('Opportunity portal request did not complete')
}

async function portalPage(portalUrl) {
  const { response, jar, url } = await portalFetch(portalUrl)
  if (!response.ok) throw new Error(`${portalProvider(portalUrl) === 'piee' ? 'PIEE' : 'FedConnect'} public opportunity could not load (${response.status})`)
  const size = Number(response.headers.get('Content-Length') || 0)
  if (size > PORTAL_HTML_LIMIT) throw new Error('Opportunity portal page was unexpectedly large')
  const contentType = clean(response.headers.get('Content-Type')).toLowerCase()
  if (contentType && !contentType.includes('html') && !contentType.includes('xhtml')) {
    throw new Error('Opportunity portal did not return a public document listing')
  }
  const html = await response.text()
  if (html.length > PORTAL_HTML_LIMIT) throw new Error('Opportunity portal page was unexpectedly large')
  return { html, jar, pageUrl: url }
}

function anchors(html) {
  return [...String(html || '').matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)].map((match) => ({
    tag: match[1],
    label: textFromHtml(match[2]),
    id: attribute(match[1], 'id'),
    href: attribute(match[1], 'href'),
    onclick: attribute(match[1], 'onclick'),
  }))
}

function fedConnectAttachments(html, portalUrl) {
  const documents = new Map()
  anchors(html).forEach((anchor) => {
    const postback = anchor.href.match(/__doPostBack\('([^']+)','([^']+)'\)/i)
    if (!postback || !/SUPPORTDOC,/i.test(postback[2])) return
    const target = postback[1]
    const id = postback[2].replace(/\\\\/g, '\\')
    const key = `${target}\n${id}`
    const current = documents.get(key)
    if (!current || (!current.name && anchor.label)) documents.set(key, { target, id, name: anchor.label || current?.name || '' })
  })
  return [...documents.values()].map((document, index) => portalSourceUrl(portalUrl, {
    provider: 'fedconnect', target: document.target, id: document.id,
    name: document.name || `FedConnect document ${index + 1}`,
  }))
}

function pieeAttachments(html, portalUrl) {
  const seen = new Set()
  const results = []
  anchors(html).forEach((anchor) => {
    const name = clean(anchor.label)
    if (!SUPPORTED_FILE_EXTENSION.test(name)) return
    const id = anchor.id || anchor.href || name
    if (seen.has(id)) return
    seen.add(id)
    results.push(portalSourceUrl(portalUrl, {
      provider: 'piee', id, name,
    }))
  })
  return results
}

export function portalAttachmentsFromHtml(portalUrl, html) {
  const provider = portalProvider(portalUrl)
  if (provider === 'fedconnect') return fedConnectAttachments(html, portalUrl)
  if (provider === 'piee') return pieeAttachments(html, portalUrl)
  return []
}

export async function discoverPortalAttachments(portalUrl, { cacheTtlSeconds = 15 * 60 } = {}) {
  if (!isSupportedPortalOpportunityUrl(portalUrl)) return []
  const cache = globalThis.caches?.default
  const cacheRequest = new Request(`https://tag-crm-portal-cache.invalid/manifest?url=${encodeURIComponent(portalUrl)}`)
  if (cache) {
    try {
      const cached = await cache.match(cacheRequest)
      if (cached) return await cached.json()
    } catch (error) {
      console.warn(JSON.stringify({ event: 'portal_manifest_cache_read_failed', portalUrl, message: clean(error.message) }))
    }
  }
  try {
    const { html } = await portalPage(portalUrl)
    const attachments = portalAttachmentsFromHtml(portalUrl, html)
    if (cache) {
      try {
        await cache.put(cacheRequest, new Response(JSON.stringify(attachments), {
          headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${cacheTtlSeconds}` },
        }))
      } catch (error) {
        console.warn(JSON.stringify({ event: 'portal_manifest_cache_write_failed', portalUrl, message: clean(error.message) }))
      }
    }
    return attachments
  } catch (error) {
    const provider = portalProvider(portalUrl)
    console.warn(JSON.stringify({
      event: 'portal_document_discovery_failed',
      provider,
      portalUrl,
      message: clean(error.message),
    }))
    return [portalSourceUrl(portalUrl, {
      provider,
      name: `${provider === 'piee' ? 'PIEE' : 'FedConnect'} opportunity documents`,
      message: `${provider === 'piee' ? 'PIEE' : 'FedConnect'} public documents could not be retrieved. Open the source link or try again later.`,
    }, true)]
  }
}

function hiddenInputs(html) {
  const params = new URLSearchParams()
  for (const match of String(html || '').matchAll(/<input\b([^>]*)>/gi)) {
    const name = attribute(match[1], 'name')
    const type = attribute(match[1], 'type').toLowerCase()
    if (name && (!type || type === 'hidden')) params.set(name, attribute(match[1], 'value'))
  }
  return params
}

function formAction(html, pageUrl) {
  const tag = String(html || '').match(/<form\b([^>]*)>/i)?.[1] || ''
  return new URL(attribute(tag, 'action') || pageUrl, pageUrl).toString()
}

function jsfParameters(anchor) {
  const values = new Map()
  const script = `${anchor.onclick || ''} ${anchor.href || ''}`
  const object = script.match(/(?:mojarra\.)?jsfcljs\([^,]+,\s*\{([\s\S]*?)\}\s*,/i)?.[1] || ''
  for (const match of object.matchAll(/['"]([^'"]+)['"]\s*:\s*['"]([^'"]*)['"]/g)) values.set(decodeHtml(match[1]), decodeHtml(match[2]))
  if (!values.size && anchor.id && /(?:jsfcljs|PrimeFaces\.ab)/i.test(script)) values.set(anchor.id, anchor.id)
  return values
}

async function downloadFedConnect(metadata) {
  const page = await portalPage(metadata.portalUrl)
  const params = hiddenInputs(page.html)
  params.set('__EVENTTARGET', metadata.target)
  params.set('__EVENTARGUMENT', metadata.id)
  const { response } = await portalFetch(formAction(page.html, page.pageUrl), {
    jar: page.jar,
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Referer: page.pageUrl,
    },
    body: params,
  })
  return response
}

async function downloadPiee(metadata) {
  const page = await portalPage(metadata.portalUrl)
  const candidates = anchors(page.html)
  const anchor = candidates.find((item) => item.id === metadata.id)
    || candidates.find((item) => clean(item.label) === metadata.name)
  if (!anchor) throw new Error(`PIEE attachment is no longer listed: ${metadata.name}`)
  if (anchor.href && !/^(?:#|javascript:)/i.test(anchor.href)) {
    const downloadUrl = new URL(anchor.href, page.pageUrl)
    if (!samePortalProvider('piee', downloadUrl)) throw new Error('PIEE attachment points outside the approved portal host')
    return (await portalFetch(downloadUrl, { jar: page.jar, headers: { Referer: page.pageUrl } })).response
  }
  const jsf = jsfParameters(anchor)
  if (!jsf.size) throw new Error(`PIEE did not expose a public download action for ${metadata.name}`)
  const params = hiddenInputs(page.html)
  jsf.forEach((value, key) => params.set(key, value))
  return (await portalFetch(formAction(page.html, page.pageUrl), {
    jar: page.jar,
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Referer: page.pageUrl,
    },
    body: params,
  })).response
}

async function fetchPortalAttachment(metadata) {
  if (metadata.issue) throw new Error(metadata.message || `${metadata.provider} public documents could not be listed`)
  if (!['fedconnect', 'piee'].includes(metadata.provider)) throw new Error('Unsupported opportunity portal attachment')
  const response = metadata.provider === 'fedconnect'
    ? await downloadFedConnect(metadata)
    : await downloadPiee(metadata)
  if (!response.ok) throw new Error(`${metadata.provider === 'piee' ? 'PIEE' : 'FedConnect'} attachment download failed (${response.status})`)
  const contentType = clean(response.headers.get('Content-Type')).toLowerCase()
  if (contentType.includes('text/html') || contentType.includes('xhtml')) {
    await response.body?.cancel().catch(() => {})
    throw new Error(`${metadata.provider === 'piee' ? 'PIEE' : 'FedConnect'} did not return a publicly downloadable file`)
  }
  return response
}

function formatSAMDate(date) {
  const d = new Date(date)
  return `${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCDate()).padStart(2, '0')}/${d.getUTCFullYear()}`
}

function searchWindow() {
  const to = new Date()
  const from = new Date(to)
  from.setUTCDate(from.getUTCDate() - 364)
  return { postedFrom: formatSAMDate(from), postedTo: formatSAMDate(to) }
}

export async function fetchWorkspaceSAMNotice(env, workspace) {
  if (!env.SAM_API_KEY) throw new Error('SAM_API_KEY is not configured')
  const { postedFrom, postedTo } = searchWindow()
  const params = new URLSearchParams({ api_key: env.SAM_API_KEY, postedFrom, postedTo, limit: '10', offset: '0' })
  if (workspace.noticeId) params.set('noticeid', workspace.noticeId)
  else if (workspace.solicitationNumber) params.set('solnum', workspace.solicitationNumber)
  else return { noticeId: '', resourceLinks: [] }
  const response = await fetch(`https://api.sam.gov/opportunities/v2/search?${params}`)
  const payload = await response.json().catch(() => null)
  if (!response.ok) throw new Error(payload?.message || `SAM.gov opportunity lookup failed (${response.status})`)
  const records = payload?.opportunitiesData || []
  const exactNotice = String(workspace.noticeId || '').trim().toLowerCase()
  const exactSolicitation = String(workspace.solicitationNumber || '').trim().toLowerCase()
  const record = records.find((item) => exactNotice && String(item.noticeId || '').trim().toLowerCase() === exactNotice)
    || records.find((item) => exactSolicitation && String(item.solicitationNumber || '').trim().toLowerCase() === exactSolicitation)
    || records[0]
  const enriched = record ? await fetchSAMStructuredResources(record) : record
  const candidateLinks = [
    enriched?.additionalInfoLink,
    ...(Array.isArray(enriched?.resourceLinks) ? enriched.resourceLinks : []),
    ...(Array.isArray(enriched?.structuredResources) ? enriched.structuredResources.map((resource) => resource.url) : []),
  ].map((url) => clean(url)).filter(Boolean)
  const portals = [...new Set(candidateLinks.filter(isSupportedPortalOpportunityUrl))].slice(0, 4)
  const portalResources = (await Promise.all(portals.map(discoverPortalAttachments))).flat()
  const directResources = [
    ...(enriched?.resourceLinks || []),
    ...(enriched?.structuredResources || []).filter((resource) => resource.retrievalEligible).map((resource) => resource.url),
  ].map((url) => clean(url)).filter((url) => url && !isSupportedPortalOpportunityUrl(url))
  return {
    noticeId: enriched?.noticeId || workspace.noticeId || '',
    resourceLinks: [...new Set([
      ...directResources,
      ...portalResources,
    ])],
  }
}

function attachmentName(response, sourceUrl, index, preferredName = '') {
  const disposition = response.headers.get('Content-Disposition') || ''
  const utf8 = disposition.match(/filename\*=UTF-8''([^;]+)/i)
  if (utf8) {
    try { return decodeURIComponent(utf8[1].replace(/^"|"$/g, '')) } catch { /* use fallbacks */ }
  }
  const simple = disposition.match(/filename="?([^";]+)"?/i)
  if (simple?.[1]) return simple[1].trim()
  if (clean(preferredName)) return clean(preferredName)
  try {
    const pathName = decodeURIComponent(new URL(sourceUrl).pathname.split('/').filter(Boolean).pop() || '')
    if (pathName && !/^(download|resource)$/i.test(pathName)) return pathName
  } catch { /* use fallback */ }
  return `SAM attachment ${index + 1}`
}

export async function fetchSAMAttachment(env, sourceUrl, index = 0) {
  const portalMetadata = portalSourceMetadata(sourceUrl)
  let response = portalMetadata ? await fetchPortalAttachment(portalMetadata) : await fetch(sourceUrl)
  if ([401, 403].includes(response.status) && env.SAM_API_KEY && isSAMResourceDownloadUrl(sourceUrl)) {
    const retryUrl = new URL(sourceUrl)
    if (!retryUrl.searchParams.has('api_key')) retryUrl.searchParams.set('api_key', env.SAM_API_KEY)
    response = await fetch(retryUrl)
  }
  if (!response.ok) throw new Error(`SAM.gov attachment download failed (${response.status})`)
  const length = Number(response.headers.get('Content-Length') || 0)
  if (length > 250 * 1024 * 1024) throw new Error('The SAM.gov attachment is larger than the supported SharePoint upload size')
  return {
    response,
    fileName: attachmentName(response, sourceUrl, index, portalMetadata?.name),
    contentType: response.headers.get('Content-Type') || 'application/octet-stream',
    byteSize: length || null,
    sourceSignature: stablePortalSourceSignature(sourceUrl) ||
      [response.headers.get('ETag'), response.headers.get('Last-Modified'), length].filter(Boolean).join('|'),
  }
}

export async function attachmentRecordId(opportunityKey, sourceUrl) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${opportunityKey}\n${sourceUrl}`))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}
