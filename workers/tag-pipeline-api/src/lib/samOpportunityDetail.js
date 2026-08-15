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

export function isSAMApiUrl(value) {
  try {
    const url = new URL(clean(value))
    return /(^|\.)api(?:-alpha)?\.sam\.gov$/i.test(url.hostname)
  } catch {
    return false
  }
}

function decodeEntities(value) {
  const named = {
    amp: '&', apos: "'", gt: '>', lt: '<', nbsp: ' ', quot: '"',
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

function normalizeLinks(raw) {
  const values = []
  const add = (value, label = '') => {
    if (Array.isArray(value)) return value.forEach((entry) => add(entry, label))
    if (value && typeof value === 'object') {
      const url = clean(value.url || value.href || value.link)
      if (url) values.push({ url, label: clean(value.label || value.name || label) || 'External opportunity link' })
      return
    }
    const url = clean(value)
    if (url) values.push({ url, label: label || 'External opportunity link' })
  }
  add(raw?.additionalInfoLink, 'Additional opportunity information')
  add(raw?.links)
  const seen = new Set()
  return values.filter((item) => {
    if (!/^https?:\/\//i.test(item.url) || isSAMApiUrl(item.url) || seen.has(item.url)) return false
    seen.add(item.url)
    return true
  })
}

export function normalizeSAMOpportunityDetail(raw = {}) {
  const organization = samOrganizationHierarchy(raw.fullParentPathName)
  const resourceLinks = unique(Array.isArray(raw.resourceLinks) ? raw.resourceLinks : [])
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
    setAside: clean(raw.typeOfSetAsideDescription || raw.typeOfSetAside),
    setAsideCode: clean(raw.typeOfSetAside),
    productServiceCode: clean(raw.classificationCode),
    naicsCode: clean(raw.naicsCode),
    placeOfPerformance: placeText(raw.placeOfPerformance),
    initiative: clean(raw.initiative),
    description: samDescriptionText(raw.descriptionText || raw.description),
    contacts: normalizeContacts(raw.pointOfContact),
    contractingOfficeAddress: addressText(raw.officeAddress),
    links: normalizeLinks(raw),
    attachments: resourceLinks.map((url, index) => ({
      sourceUrl: url,
      fileName: fileNameFromUrl(url, index),
      archiveStatus: 'pending',
    })),
    samUrl: isSAMApiUrl(raw.uiLink)
      ? (clean(raw.noticeId) ? `https://sam.gov/opp/${encodeURIComponent(clean(raw.noticeId))}/view` : '')
      : clean(raw.uiLink),
  }
}
