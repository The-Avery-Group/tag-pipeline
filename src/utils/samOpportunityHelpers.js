import { isRfiWorkflowNoticeType, normalizeNoticeType } from './noticeTypes.js'
import { serializeSAMPOCs } from './samPoc.js'

const NOTICE_TYPES = new Set(['RFI', 'MRAS', 'RFP', 'RFQ'])

export function cleanSAMOpportunityTitle(value) {
  return String(value || '').replace(/\s+/g, ' ').trim()
}

export function normalizeSAMNoticeType(value) {
  const values = (Array.isArray(value) ? value : [value])
    .map((item) => String(item || '').trim().toUpperCase())
    .filter(Boolean)
  const combined = values.join(' ')
  if (values.includes('MRAS') || combined.includes('MARKET RESEARCH')) return 'MRAS'
  if (values.includes('K') || values.includes('RFQ') || combined.includes('COMBINED')) return 'RFQ'
  if (values.includes('O') || values.includes('RFP') || combined.includes('SOLICITATION')) return 'RFP'
  if (values.includes('R') || values.includes('RFI') || (combined.includes('SOURCE') && combined.includes('SOUGHT'))) return 'RFI'
  if (values.some((type) => NOTICE_TYPES.has(type))) return values.find((type) => NOTICE_TYPES.has(type))
  return ''
}

function parseOrganization(value) {
  const parts = String(value || '').split('.').map((part) => part.trim()).filter(Boolean)
  return {
    department: parts[0] || '',
    agency: parts[1] || parts[0] || '',
    office: parts[2] || '',
  }
}

export function applySAMSnapshot(row, snapshot) {
  if (!snapshot) return row
  const organization = parseOrganization(snapshot.organization)
  return {
    ...row,
    'Notice ID': snapshot.noticeId || row['Notice ID'],
    'Solicitation Number': snapshot.solicitationNumber || row['Solicitation Number'],
    Title: cleanSAMOpportunityTitle(snapshot.title || row.Title),
    'Notice Type': normalizeSAMNoticeType([snapshot.type, snapshot.baseType, snapshot.title, row['Notice Type']]),
    'Set-Aside Type': snapshot.setAside || row['Set-Aside Type'],
    Department: organization.department || row.Department,
    Agency: organization.agency || row.Agency,
    Office: organization.office || row.Office,
    'Response Date': snapshot.responseDate || row['Response Date'],
    'Point of Contact': serializeSAMPOCs(snapshot.pointOfContact) || row['Point of Contact'],
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

export function isSAMOpportunityFlagged(value) {
  return ['yes', 'true', '1', 'flagged'].includes(String(value || '').trim().toLowerCase())
}

export function samTypeMatches(row, selectedType) {
  if (selectedType === 'All') return true
  const noticeType = normalizeSAMNoticeType(row['Notice Type'])
  if (selectedType === 'RFI_MRAS') return isRfiWorkflowNoticeType(noticeType)
  return noticeType === normalizeNoticeType(selectedType)
}

function normalizedIdentity(value) {
  return String(value || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '')
}

function statusWeight(status) {
  return ['dismissed', 'added_to_pipeline', 'tracked'].includes(String(status || '').toLowerCase()) ? 1 : 0
}

function shouldReplaceSAMDuplicate(current, candidate) {
  const currentWeight = statusWeight(current.Status)
  const candidateWeight = statusWeight(candidate.Status)
  if (candidateWeight !== currentWeight) return candidateWeight > currentWeight
  const currentPosted = sortableDate(current['Posted Date']) ?? -Infinity
  const candidatePosted = sortableDate(candidate['Posted Date']) ?? -Infinity
  if (candidatePosted !== currentPosted) return candidatePosted > currentPosted
  return Number(candidate._rowIndex || 0) > Number(current._rowIndex || 0)
}

function mergeSAMDuplicate(current, candidate) {
  const selected = shouldReplaceSAMDuplicate(current, candidate) ? candidate : current
  if (!isSAMOpportunityFlagged(current.Flagged) && !isSAMOpportunityFlagged(candidate.Flagged)) return selected
  return isSAMOpportunityFlagged(selected.Flagged) ? selected : { ...selected, Flagged: 'Yes' }
}

/**
 * Keeps malformed or concurrently inserted workbook duplicates from
 * rendering twice. RFI and later procurement notices remain separate, while
 * equal-type notices with the same notice ID or solicitation collapse.
 */
export function dedupeSAMOpportunities(rows) {
  const byNotice = new Map()
  const withoutNotice = []
  ;(rows || []).forEach((row) => {
    const notice = normalizedIdentity(row['Notice ID'])
    if (!notice) {
      withoutNotice.push(row)
      return
    }
    const current = byNotice.get(notice)
    if (!current) byNotice.set(notice, row)
    else byNotice.set(notice, mergeSAMDuplicate(current, row))
  })

  const bySolicitationAndType = new Map()
  ;[...byNotice.values(), ...withoutNotice].forEach((row) => {
    const solicitation = normalizedIdentity(row['Solicitation Number'])
    const type = normalizeSAMNoticeType(row['Notice Type'])
    const key = solicitation ? `${type}:${solicitation}` : `ROW:${row._rowIndex}`
    const current = bySolicitationAndType.get(key)
    if (!current) bySolicitationAndType.set(key, row)
    else bySolicitationAndType.set(key, mergeSAMDuplicate(current, row))
  })
  return [...bySolicitationAndType.values()]
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
    [columns.noticeType, normalizeSAMNoticeType([snapshot.type, snapshot.baseType, snapshot.title])],
    [columns.title, cleanSAMOpportunityTitle(snapshot.title)],
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
    if (!column) return
    const next = String(incoming || '').trim()
    const current = String(opportunity[column] || '').trim()
    if (!next || next === current) return
    patch[column] = next
    changes.push({ column, current, next })
  })
  return { patch, changes }
}
