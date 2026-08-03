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

/**
 * RFI and MRAS share the same capture workflow. Submitted RFI is retained as
 * a fallback only for older workbook rows created before Notice Type existed.
 */
export function isRfiWorkflowOpportunity(opportunity, columns = {}) {
  const noticeTypeColumn = columns.noticeType || 'Notice Type'
  const activityPhaseColumn = columns.activityPhase || columns.actPhase || 'TAG Pipeline Activity Phase'
  const noticeType = normalizeNoticeType(opportunity?.[noticeTypeColumn])
  if (noticeType) return isRfiWorkflowNoticeType(noticeType)
  return String(opportunity?.[activityPhaseColumn] || '').trim() === 'Submitted RFI'
}

export function noticeTypeDisplay(value, fallback = 'Not classified') {
  return normalizeNoticeType(value) || fallback
}
