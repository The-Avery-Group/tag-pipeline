function clean(value) {
  return String(value ?? '').trim()
}

function noticeType(...values) {
  const types = values.flat().map((value) => clean(value).toUpperCase()).filter(Boolean)
  const combined = types.join(' ')
  if (types.includes('MRAS') || combined.includes('MARKET RESEARCH')) return 'MRAS'
  if (types.includes('K') || types.includes('RFQ') || combined.includes('COMBINED')) return 'RFQ'
  if (types.includes('O') || types.includes('RFP') || combined.includes('SOLICITATION')) return 'RFP'
  if (types.includes('R') || types.includes('RFI') || (combined.includes('SOURCE') && combined.includes('SOUGHT'))) return 'RFI'
  return ''
}

function unique(values) {
  return [...new Set(values.map(clean).filter(Boolean))]
}

const DOCUMENT_EXTENSION = /\.(?:csv|docx?|gif|jpe?g|json|odt|pdf|png|pptx?|rtf|txt|xls[xm]?|xml|zip)$/i
const FORM_EVIDENCE = /\b(?:form|sf|of)\s*[-#]?\s*\d+[a-z]?\b/i
const RESOURCE_TYPE_LABELS = {
  opportunity_portal: 'Opportunity portal',
  document: 'Document',
  form: 'Form',
  reference: 'Reference website',
  external: 'External link',
}

export function isSAMApiUrl(value) {
  try {
    const url = new URL(clean(value))
    return /(^|\.)api(?:-alpha)?\.sam\.gov$/i.test(url.hostname)
  } catch {
    return false
  }
}

export function isSAMResourceDownloadUrl(value) {
  try {
    const url = new URL(clean(value))
    const isSamHost = /(^|\.)(?:api(?:-alpha)?\.)?sam\.gov$/i.test(url.hostname)
    return isSamHost && /\/opportunities\/resources\/files\//i.test(url.pathname)
  } catch {
    return false
  }
}

function validHttpsUrl(value) {
  try {
    const url = new URL(clean(value))
    return url.protocol === 'https:' ? url : null
  } catch {
    return null
  }
}

function resourceFileName(resource, index) {
  const explicit = clean(resource?.fileName || resource?.filename || resource?.name || resource?.title)
  if (explicit && DOCUMENT_EXTENSION.test(explicit)) return explicit
  const fromUrl = fileNameFromUrl(clean(resource?.uri || resource?.url || resource?.href), index)
  return DOCUMENT_EXTENSION.test(fromUrl) ? fromUrl : explicit || fromUrl
}

function isOpportunityPortal(url, label = '') {
  const hostname = url.hostname.toLowerCase().replace(/^www\./, '')
  const path = `${url.pathname}${url.search}`.toLowerCase()
  if (hostname === 'fedconnect.net' || hostname.endsWith('.fedconnect.net')) {
    return /[?&](?:doc|opportunityid)=/i.test(url.search) || /opportunit/i.test(path) || /opportunit/i.test(label)
  }
  if (hostname === 'piee.eb.mil' || hostname.endsWith('.piee.eb.mil')) {
    return /(?:solicitation|(?:^|\/)sol(?:\/|$)|notice|opportunit)/i.test(path) || /(?:solicitation|opportunit|notice)/i.test(label)
  }
  if (hostname === 'ebuy.gsa.gov' || hostname.endsWith('.ebuy.gsa.gov')) return true
  return false
}

function isApprovedRetrievalHost(url) {
  const hostname = url.hostname.toLowerCase()
  return hostname === 'sam.gov' || hostname.endsWith('.sam.gov') || hostname.endsWith('.gov') || hostname.endsWith('.mil')
}

export function classifySAMResource(resource = {}, index = 0) {
  const url = validHttpsUrl(resource.uri || resource.url || resource.href || resource.link)
  if (!url) return null
  const description = clean(resource.description || resource.label || resource.title || resource.name)
  const fileName = resourceFileName(resource, index)
  const declaredType = clean(resource.type || resource.resourceType).toLowerCase()
  const contentType = clean(resource.contentType || resource.mimeType).toLowerCase()
  const fileEvidence = declaredType && declaredType !== 'link'
    || DOCUMENT_EXTENSION.test(url.pathname)
    || DOCUMENT_EXTENSION.test(fileName)
    || /(?:application|image|text)\//.test(contentType)
  let resourceType = 'external'
  if (fileEvidence) resourceType = FORM_EVIDENCE.test(`${fileName} ${description}`) ? 'form' : 'document'
  else if (isOpportunityPortal(url, description)) resourceType = 'opportunity_portal'
  else if (url.hostname.toLowerCase().endsWith('.gov') || url.hostname.toLowerCase().endsWith('.mil')) resourceType = 'reference'
  return {
    id: clean(resource.attachmentId || resource.resourceId || resource.id),
    url: url.toString(),
    description,
    fileName,
    declaredType,
    contentType,
    resourceType,
    resourceTypeLabel: RESOURCE_TYPE_LABELS[resourceType],
    retrievalEligible: ['document', 'form'].includes(resourceType) && isApprovedRetrievalHost(url),
  }
}

export function normalizeSAMStructuredResources(payload) {
  const lists = payload?._embedded?.opportunityAttachmentList
    || payload?.opportunityAttachmentList
    || payload?.resources
    || []
  const raw = (Array.isArray(lists) ? lists : [lists]).flatMap((entry) => (
    Array.isArray(entry?.attachments) ? entry.attachments : entry
  )).filter(Boolean)
  const seen = new Set()
  return raw.map(classifySAMResource).filter((resource) => {
    if (!resource || seen.has(resource.url.toLowerCase())) return false
    seen.add(resource.url.toLowerCase())
    return true
  })
}

export async function fetchSAMStructuredResources(record, { cacheTtlSeconds = 15 * 60 } = {}) {
  const noticeId = clean(record?.noticeId)
  if (!noticeId) return { ...record, structuredResources: [] }
  const endpoint = `https://sam.gov/api/prod/opps/v3/opportunities/${encodeURIComponent(noticeId)}/resources`
  // SAM's website endpoint currently rejects an explicit application/json
  // Accept header even though it returns JSON.
  const request = new Request(endpoint)
  const edgeCache = globalThis.caches?.default
  try {
    const cached = await edgeCache?.match(request)
    if (cached) return { ...record, structuredResources: await cached.json() }
    const response = await fetch(request)
    if (!response.ok) throw new Error(`SAM.gov resources lookup failed (${response.status})`)
    const contentLength = Number(response.headers.get('Content-Length') || 0)
    if (contentLength > 5 * 1024 * 1024) throw new Error('SAM.gov resources response was unexpectedly large')
    const resources = normalizeSAMStructuredResources(await response.json())
    if (edgeCache) {
      await edgeCache.put(request, new Response(JSON.stringify(resources), {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${cacheTtlSeconds}` },
      }))
    }
    return { ...record, structuredResources: resources }
  } catch (error) {
    console.warn(JSON.stringify({ event: 'sam_resources_fetch_failed', noticeId, message: error.message }))
    return { ...record, structuredResources: [] }
  }
}

function decodeEntities(value) {
  const named = {
    amp: '&', apos: "'", bull: '•', copy: '©', deg: '°', gt: '>', hellip: '…',
    laquo: '«', ldquo: '“', lsquo: '‘', lt: '<', mdash: '—', middot: '·',
    nbsp: ' ', ndash: '–', quot: '"', raquo: '»', rdquo: '”', reg: '®',
    rsquo: '’', trade: '™',
  }
  return String(value || '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity) => {
    if (entity[0] === '#') {
      const hex = entity[1]?.toLowerCase() === 'x'
      const codePoint = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10)
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match
    }
    return named[entity.toLowerCase()] ?? match
  })
}

function descriptionCandidate(value) {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(descriptionCandidate).filter(Boolean).join('\n\n')
  if (!value || typeof value !== 'object') return ''
  for (const field of ['body', 'description', 'content', 'text', 'data']) {
    const candidate = descriptionCandidate(value[field])
    if (candidate) return candidate
  }
  return ''
}

export function samDescriptionText(value) {
  let source = descriptionCandidate(value).trim()
  if (!source || isSAMApiUrl(source) || /^description not found\.?$/i.test(source)) return ''
  source = source
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<a\b[^>]*href\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi, (_match, _quote, href, label) => {
      const text = decodeEntities(String(label || '').replace(/<[^>]+>/g, '')).trim() || 'Open link'
      return isSAMApiUrl(href) ? text : `[${text}](${href})`
    })
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<\/\s*(p|div|h[1-6]|blockquote)\s*>/gi, '\n\n')
    .replace(/<\/\s*(li|ul|ol|table|tr)\s*>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, '')
  return decodeEntities(source)
    .replace(/https?:\/\/api(?:-alpha)?\.sam\.gov\/\S+/gi, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function pathParts(value) {
  return clean(value).split('.').map(clean).filter(Boolean)
}

function fileNameFromUrl(value, index) {
  try {
    const url = new URL(value)
    const parts = url.pathname.split('/').filter(Boolean).map((part) => decodeURIComponent(part))
    const last = parts.at(-1) || ''
    const candidate = /^(download|resource)$/i.test(last) ? parts.at(-2) || '' : last
    if (candidate) return candidate
  } catch { /* use the stable fallback */ }
  return `SAM attachment ${index + 1}`
}

function addressText(value) {
  if (!value) return ''
  if (typeof value === 'string') return clean(value)
  return [
    value.streetAddress || value.addressLine1,
    value.streetAddress2 || value.addressLine2,
    [value.city, value.state || value.stateCode, value.zip || value.zipCode].map(clean).filter(Boolean).join(', '),
    value.country || value.countryCode,
  ].map(clean).filter(Boolean).join('\n')
}

function placeText(value) {
  if (!value) return ''
  if (typeof value === 'string') return clean(value)
  const city = value.city?.name || value.city
  const state = value.state?.name || value.state?.code || value.state
  const country = value.country?.name || value.country?.code || value.country
  const zip = value.zip || value.zipCode
  return [[city, state, zip].map(clean).filter(Boolean).join(', '), country].map(clean).filter(Boolean).join('\n')
}

export function samOrganizationHierarchy(fullParentPathName) {
  const parts = pathParts(fullParentPathName)
  const middle = parts.slice(2, -1)
  return {
    department: parts[0] || '',
    subTier: parts[1] || parts[0] || '',
    majorCommand: middle[0] || '',
    subCommand1: middle[1] || '',
    subCommand2: middle[2] || '',
    subCommand3: middle.slice(3).join(' · '),
    office: parts.length > 2 ? parts.at(-1) : '',
    fullPath: parts,
  }
}

function normalizeContacts(value) {
  const contacts = Array.isArray(value) ? value : []
  const seen = new Set()
  return contacts.map((contact) => ({
    type: clean(contact?.type),
    name: clean(contact?.fullName || contact?.fullname || contact?.name),
    title: clean(contact?.title),
    email: clean(contact?.email),
    phone: clean(contact?.phone),
    fax: clean(contact?.fax),
  })).filter((contact) => {
    const key = contact.email.toLowerCase() || `${contact.name.toLowerCase()}|${contact.phone}`
    if (!key || seen.has(key)) return false
    seen.add(key)
    return true
  }).sort((left, right) => Number(right.type.toLowerCase() === 'primary') - Number(left.type.toLowerCase() === 'primary'))
}

function authoritativeLinkTitle(value, proposedLabel = '') {
  let hostname = ''
  try { hostname = new URL(clean(value)).hostname.toLowerCase().replace(/^www\./, '') } catch { return '' }
  const label = clean(proposedLabel)
  const generic = /^(external opportunity link|additional opportunity information|link from sam\.gov posting|open link)$/i.test(label)
  if (label && !generic) return label
  if (hostname === 'piee.eb.mil' || hostname.endsWith('.piee.eb.mil')) return 'PIEE solicitation'
  if (hostname === 'fedconnect.net' || hostname.endsWith('.fedconnect.net')) return 'FedConnect notice'
  if (hostname === 'ebuy.gsa.gov' || hostname.endsWith('.ebuy.gsa.gov')) return 'GSA eBuy request'
  if (hostname === 'acquisition.gov' || hostname.endsWith('.acquisition.gov')) return 'Acquisition.gov information'
  if (hostname === 'grants.gov' || hostname.endsWith('.grants.gov')) return 'Grants.gov notice'
  return hostname
}

function normalizeLinks(raw) {
  const values = []
  const add = (value, source, label = '', metadata = {}) => {
    if (Array.isArray(value)) return value.forEach((entry) => add(entry, source, label))
    if (value && typeof value === 'object') {
      const url = clean(value.url || value.href || value.link)
      if (url) {
        const classified = classifySAMResource({ ...value, uri: url, description: value.description || value.title || value.label || value.name || label })
        if (classified) values.push({
          url: classified.url,
          label: authoritativeLinkTitle(classified.url, classified.description),
          source,
          resourceType: classified.resourceType,
          resourceTypeLabel: classified.resourceTypeLabel,
          retrievalEligible: classified.retrievalEligible,
          ...metadata,
        })
      }
      return
    }
    const url = clean(value)
    const classified = classifySAMResource({ uri: url, description: label, type: 'link' })
    if (classified) values.push({
      url: classified.url,
      label: authoritativeLinkTitle(classified.url, label),
      source,
      resourceType: classified.resourceType,
      resourceTypeLabel: classified.resourceTypeLabel,
      retrievalEligible: classified.retrievalEligible,
      ...metadata,
    })
  }
  // Only fields supplied by SAM as link/resource fields belong in the
  // External links section. URLs mentioned in the free-form description
  // remain readable there but are never promoted into structured links.
  add(raw?.additionalInfoLink, 'additionalInfoLink')
  add(raw?.links, 'links')
  add(raw?.resourceLinks, 'resourceLinks')
  ;(raw?.structuredResources || []).filter((resource) => !resource.retrievalEligible).forEach((resource) => {
    add({
      url: resource.url,
      description: resource.description,
      type: resource.declaredType || 'link',
    }, 'samResources', '', {
      resourceType: resource.resourceType,
      resourceTypeLabel: resource.resourceTypeLabel,
      retrievalEligible: resource.retrievalEligible,
    })
  })
  const seen = new Set()
  return values.filter((item) => {
    const key = item.url.toLowerCase()
    if (!/^https?:\/\//i.test(item.url) || !item.label || isSAMApiUrl(item.url) || isSAMResourceDownloadUrl(item.url) || seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export function normalizeSAMOpportunityDetail(raw = {}) {
  const organization = samOrganizationHierarchy(raw.fullParentPathName)
  const structuredResources = Array.isArray(raw.structuredResources) ? raw.structuredResources : []
  const resourceLinks = unique([
    ...(Array.isArray(raw.resourceLinks) ? raw.resourceLinks : []),
    ...structuredResources.filter((resource) => resource.retrievalEligible).map((resource) => resource.url),
  ]
    .map((value) => typeof value === 'object' ? value?.url || value?.href || value?.link : value))
  const structuredByUrl = new Map(structuredResources.map((resource) => [clean(resource.url).toLowerCase(), resource]))
  resourceLinks.forEach((url, index) => {
    const key = url.toLowerCase()
    if (structuredByUrl.has(key)) return
    const classified = classifySAMResource({ uri: url, type: isSAMResourceDownloadUrl(url) ? 'file' : 'link' }, index)
    if (classified) structuredByUrl.set(key, classified)
  })
  return {
    noticeId: clean(raw.noticeId),
    solicitationNumber: clean(raw.solicitationNumber),
    title: clean(raw.title).replace(/\s+/g, ' '),
    status: raw.active === false ? 'Inactive' : 'Active',
    active: raw.active !== false,
    noticeType: noticeType(raw.type, raw.baseType, raw.title),
    opportunityType: clean(raw.type || raw.baseType),
    baseType: clean(raw.baseType),
    relatedNotice: clean(raw.relatedNotice || raw.relatedNoticeId),
    contractLineItemNumber: clean(raw.contractLineItemNumber),
    responseDeadline: clean(raw.responseDeadLine),
    postedDate: clean(raw.postedDate),
    modifiedDate: clean(raw.modifiedDate || raw.lastModifiedDate),
    archiveDate: clean(raw.archiveDate),
    archiveType: clean(raw.archiveType),
    organization,
    setAside: clean(raw.typeOfSetAsideDescription || raw.setAsideDescription || raw.typeOfSetAside || raw.setAside),
    setAsideCode: clean(raw.typeOfSetAside || raw.setAsideCode),
    award: raw.award ? {
      number: clean(raw.award.number),
      date: clean(raw.award.date),
      amount: Number(raw.award.amount || 0) || null,
      awardeeName: clean(raw.award.awardee?.name),
      awardeeUEI: clean(raw.award.awardee?.ueiSAM || raw.award.awardee?.uei),
    } : null,
    productServiceCode: clean(raw.classificationCode),
    naicsCode: clean(raw.naicsCode),
    placeOfPerformance: placeText(raw.placeOfPerformance),
    initiative: clean(raw.initiative),
    description: samDescriptionText(raw.descriptionText || raw.description),
    contacts: normalizeContacts(raw.pointOfContact),
    contractingOfficeAddress: addressText(raw.officeAddress),
    links: normalizeLinks(raw),
    attachments: resourceLinks.filter((url) => isSAMResourceDownloadUrl(url) || structuredByUrl.get(url.toLowerCase())?.retrievalEligible).map((url, index) => ({
      sourceUrl: url,
      fileName: structuredByUrl.get(url.toLowerCase())?.fileName || fileNameFromUrl(url, index),
      resourceType: structuredByUrl.get(url.toLowerCase())?.resourceType || 'document',
      resourceTypeLabel: structuredByUrl.get(url.toLowerCase())?.resourceTypeLabel || 'Document',
      archiveStatus: 'pending',
    })),
    samUrl: isSAMApiUrl(raw.uiLink)
      ? (clean(raw.noticeId) ? `https://sam.gov/opp/${encodeURIComponent(clean(raw.noticeId))}/view` : '')
      : clean(raw.uiLink),
  }
}
