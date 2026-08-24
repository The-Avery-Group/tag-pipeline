export const NOTICE_TYPE_VALUES = ['RFI', 'MRAS', 'RFP', 'RFQ']

export function normalizeNoticeType(value) {
  const normalized = String(value || '').trim().toUpperCase()
  if (NOTICE_TYPE_VALUES.includes(normalized)) return normalized
  if (normalized.includes('MRAS') || normalized.includes('MARKET RESEARCH')) return 'MRAS'
  if (normalized === 'R' || normalized.includes('RFI') || (normalized.includes('SOURCE') && normalized.includes('SOUGHT'))) return 'RFI'
  if (normalized === 'K' || normalized.includes('RFQ') || normalized.includes('COMBINED')) return 'RFQ'
  if (normalized === 'O' || normalized.includes('RFP') || normalized.includes('SOLICITATION')) return 'RFP'
  return ''
}

export function isRfiWorkflowNoticeType(value) {
  return ['RFI', 'MRAS'].includes(normalizeNoticeType(value))
}

export function isTrackedOpportunity(opportunity, columns = {}) {
  const outlookColumn = columns.outlook || 'Opportunity Outlook'
  return ['tracked', 'tracking'].includes(String(opportunity?.[outlookColumn] || '').trim().toLowerCase())
}

export function submittedActivityNoticeType(value) {
  const normalized = String(value || '').trim().replace(/\s+/g, ' ').toUpperCase()
  if (!normalized) return ''
  if (normalized === 'PROPOSAL SUBMITTED') return 'RFP'
  if (!normalized.startsWith('SUBMITTED ')) return ''
  if (normalized.includes('MARKET RESEARCH') || normalized.includes('MRAS')) return 'MRAS'
  if (normalized.includes('RFQ')) return 'RFQ'
  if (normalized.includes('RFP') || normalized.includes('PROPOSAL')) return 'RFP'
  if (normalized.includes('RFI')) return 'RFI'
  return 'Unclassified'
}

/** All currently supported response notice types, plus legacy submitted rows. */
export function isResponseOpportunity(opportunity, columns = {}) {
  if (isTrackedOpportunity(opportunity, columns)) return false
  const noticeTypeColumn = columns.noticeType || 'Notice Type'
  const activityPhaseColumn = columns.activityPhase || columns.actPhase || 'TAG Pipeline Activity Phase'
  return Boolean(
    normalizeNoticeType(opportunity?.[noticeTypeColumn]) ||
    submittedActivityNoticeType(opportunity?.[activityPhaseColumn])
  )
}

/** A submission is established by workflow state, not merely by a due date. */
export function isSubmittedOpportunity(opportunity, columns = {}) {
  const activityPhaseColumn = columns.activityPhase || columns.actPhase || 'TAG Pipeline Activity Phase'
  return Boolean(submittedActivityNoticeType(opportunity?.[activityPhaseColumn]))
}

export function submittedOpportunityNoticeType(opportunity, columns = {}) {
  if (!isSubmittedOpportunity(opportunity, columns)) return ''
  const noticeTypeColumn = columns.noticeType || 'Notice Type'
  const activityPhaseColumn = columns.activityPhase || columns.actPhase || 'TAG Pipeline Activity Phase'
  return normalizeNoticeType(opportunity?.[noticeTypeColumn]) ||
    submittedActivityNoticeType(opportunity?.[activityPhaseColumn]) ||
    'Unclassified'
}

/**
 * RFI and MRAS share the same capture workflow. Submitted RFI is retained as
 * a fallback only for older workbook rows created before Notice Type existed.
 */
export function isRfiWorkflowOpportunity(opportunity, columns = {}) {
  if (isTrackedOpportunity(opportunity, columns)) return false
  const noticeTypeColumn = columns.noticeType || 'Notice Type'
  const activityPhaseColumn = columns.activityPhase || columns.actPhase || 'TAG Pipeline Activity Phase'
  const noticeType = normalizeNoticeType(opportunity?.[noticeTypeColumn])
  if (noticeType) return isRfiWorkflowNoticeType(noticeType)
  return String(opportunity?.[activityPhaseColumn] || '').trim() === 'Submitted RFI'
}

/**
 * Follow-on discovery starts from submitted market-research records and RFQs.
 * RFQs remain eligible because an RFQ can later be replaced or followed by an
 * RFP for the same requirement.
 */
export function isFollowOnSourceOpportunity(opportunity, columns = {}) {
  if (isTrackedOpportunity(opportunity, columns)) return false
  const noticeTypeColumn = columns.noticeType || 'Notice Type'
  const activityPhaseColumn = columns.activityPhase || columns.actPhase || 'TAG Pipeline Activity Phase'
  const noticeType = normalizeNoticeType(opportunity?.[noticeTypeColumn])
  if (noticeType) return ['RFI', 'MRAS', 'RFQ'].includes(noticeType)
  const activityType = submittedActivityNoticeType(opportunity?.[activityPhaseColumn])
  return ['RFI', 'MRAS', 'RFQ'].includes(activityType)
}

export function noticeTypeDisplay(value, fallback = 'Not classified') {
  return normalizeNoticeType(value) || fallback
}
