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
    if (!/^https?:\/\//i.test(item.url) || seen.has(item.url)) return false
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
    description: clean(raw.description),
    contacts: normalizeContacts(raw.pointOfContact),
    contractingOfficeAddress: addressText(raw.officeAddress),
    links: normalizeLinks(raw),
    attachments: resourceLinks.map((url, index) => ({
      sourceUrl: url,
      fileName: fileNameFromUrl(url, index),
      archiveStatus: 'pending',
    })),
    samUrl: clean(raw.uiLink),
  }
}
