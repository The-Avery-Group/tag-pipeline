const NOTICE_TYPES = new Set(['RFI', 'RFP', 'RFQ'])

export function normalizeSAMNoticeType(value) {
  const type = String(value || '').trim().toUpperCase()
  if (NOTICE_TYPES.has(type)) return type
  if (type.includes('SOURCE') && type.includes('SOUGHT')) return 'RFI'
  if (type.includes('COMBINED')) return 'RFQ'
  if (type.includes('SOLICITATION')) return 'RFP'
  // Rows pulled before Notice Type was introduced were all Sources Sought.
  return 'RFI'
}

function parseOrganization(value) {
  const parts = String(value || '').split('.').map((part) => part.trim()).filter(Boolean)
  return {
    department: parts[0] || '',
    agency: parts[1] || parts[0] || '',
    office: parts[2] || '',
  }
}

function primaryPOC(value) {
  const contacts = Array.isArray(value) ? value : []
  const primary = contacts.find((entry) => String(entry || '').trim()) || ''
  return String(primary)
    .split('|')
    .map((part) => part.trim())
    .filter(Boolean)
    .join(' | ')
}

export function applySAMSnapshot(row, snapshot) {
  if (!snapshot) return row
  const organization = parseOrganization(snapshot.organization)
  return {
    ...row,
    'Notice ID': snapshot.noticeId || row['Notice ID'],
    'Solicitation Number': snapshot.solicitationNumber || row['Solicitation Number'],
    Title: snapshot.title || row.Title,
    'Notice Type': normalizeSAMNoticeType(snapshot.type || snapshot.baseType || row['Notice Type']),
    'Set-Aside Type': snapshot.setAside || row['Set-Aside Type'],
    Department: organization.department || row.Department,
    Agency: organization.agency || row.Agency,
    Office: organization.office || row.Office,
    'Response Date': snapshot.responseDate || row['Response Date'],
    'Point of Contact': primaryPOC(snapshot.pointOfContact) || row['Point of Contact'],
    'NAICS Code': snapshot.naics || row['NAICS Code'],
    'Posted Date': snapshot.postedDate || row['Posted Date'],
    'SAM.gov URL': snapshot.uiLink || row['SAM.gov URL'],
  }
}

function sortableDate(value) {
  const parsed = Date.parse(String(value || ''))
  return Number.isFinite(parsed) ? parsed : null
}

export function sortSAMOpportunities(rows, mode = 'dateAdded') {
  return [...rows].sort((left, right) => {
    if (mode === 'responseAsc' || mode === 'responseDesc') {
      const a = sortableDate(left['Response Date'])
      const b = sortableDate(right['Response Date'])
      if (a === null && b === null) return Number(right._rowIndex || 0) - Number(left._rowIndex || 0)
      if (a === null) return 1
      if (b === null) return -1
      return mode === 'responseAsc' ? a - b : b - a
    }

    const a = sortableDate(left['Date Added'])
    const b = sortableDate(right['Date Added'])
    if (a !== b) {
      if (a === null) return 1
      if (b === null) return -1
      return b - a
    }
    return Number(right._rowIndex || 0) - Number(left._rowIndex || 0)
  })
}

export function samTypeMatches(row, selectedType) {
  return selectedType === 'All' || normalizeSAMNoticeType(row['Notice Type']) === selectedType
}

function cleanLinks(value) {
  return String(value || '').split('\n').map((link) => link.trim()).filter(Boolean)
}

export function buildSAMOpportunityPatch(opportunity, snapshot, columns) {
  if (!opportunity || !snapshot) return { patch: {}, changes: [] }
  const organization = parseOrganization(snapshot.organization)
  const samLink = String(snapshot.uiLink || '').trim()
  const currentLinks = cleanLinks(opportunity[columns.otherLinks])
  const nextLinks = samLink && !currentLinks.includes(samLink) ? [...currentLinks, samLink] : currentLinks
  const candidates = [
    [columns.title, snapshot.title],
    [columns.solNum, snapshot.solicitationNumber],
    [columns.setAside, snapshot.setAside],
    [columns.department, organization.department],
    [columns.agency, organization.agency],
    [columns.office, organization.office],
    [columns.naics, snapshot.naics],
    [columns.submDate, snapshot.responseDate],
    [columns.otherLinks, nextLinks.join('\n')],
  ]

  const patch = {}
  const changes = []
  candidates.forEach(([column, incoming]) => {
    const next = String(incoming || '').trim()
    const current = String(opportunity[column] || '').trim()
    if (!next || next === current) return
    patch[column] = next
    changes.push({ column, current, next })
  })
  return { patch, changes }
}
