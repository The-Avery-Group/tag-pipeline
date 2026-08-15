export function normalizeNoticeType(value) {
  const normalized = String(value || '').trim().toUpperCase()
  if (['RFI', 'MRAS', 'RFP', 'RFQ'].includes(normalized)) return normalized
  if (normalized.includes('MRAS') || normalized.includes('MARKET RESEARCH')) return 'MRAS'
  if (normalized === 'R' || normalized.includes('RFI') || (normalized.includes('SOURCE') && normalized.includes('SOUGHT'))) return 'RFI'
  if (normalized === 'K' || normalized.includes('RFQ') || normalized.includes('COMBINED')) return 'RFQ'
  if (normalized === 'O' || normalized.includes('RFP') || normalized.includes('SOLICITATION')) return 'RFP'
  return ''
}

export function isRfiWorkflowNoticeType(value) {
  return ['RFI', 'MRAS'].includes(normalizeNoticeType(value))
}

export function isRfiWorkflowOpportunity(opportunity) {
  const noticeType = normalizeNoticeType(opportunity?.['Notice Type'])
  if (noticeType) return isRfiWorkflowNoticeType(noticeType)
  return String(opportunity?.['TAG Pipeline Activity Phase'] || '').trim() === 'Submitted RFI'
}

export function isFollowOnSourceOpportunity(opportunity) {
  const noticeType = normalizeNoticeType(opportunity?.['Notice Type'])
  if (noticeType) return ['RFI', 'MRAS', 'RFQ'].includes(noticeType)
  const phase = String(opportunity?.['TAG Pipeline Activity Phase'] || '').trim().toUpperCase()
  return phase === 'SUBMITTED RFI' || phase === 'SUBMITTED MARKET RESEARCH' || phase === 'SUBMITTED RFQ'
}
