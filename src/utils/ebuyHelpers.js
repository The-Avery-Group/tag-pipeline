import { normalizeNoticeType } from './noticeTypes.js'

export function normalizeEbuyNoticeType(opportunity) {
  const record = opportunity && typeof opportunity === 'object'
    ? opportunity
    : { requestType: opportunity }
  const sourceType = record.sourceDetails?.rfqInfo?.requestTypeString
  const explicitType = normalizeNoticeType(sourceType) || normalizeNoticeType(record.requestType)
  const titleType = normalizeNoticeType(record.title)

  // eBuy commonly assigns an RFI-prefixed Request ID to MRAS notices. The
  // explicit source label and opportunity title are therefore more specific
  // than the Request ID-derived RFI classification.
  if (explicitType === 'MRAS' || titleType === 'MRAS') return 'MRAS'
  return explicitType
}

export function ebuyToPipelineRecord(opportunity, outlook = 'New') {
  const buyerContact = [opportunity.buyerName, opportunity.buyerEmail, opportunity.buyerPhone]
    .map((value) => String(value || '').trim()).filter(Boolean).join(' | ')
  const vehicle = opportunity.vehiclePairs?.length
    ? opportunity.vehiclePairs.join(', ')
    : opportunity.vehicleSources?.join(', ') || ''
  return {
    'Contract Number / Notice ID': opportunity.requestId,
    'Project Title / Description*': String(opportunity.title || '').replace(/\s+/g, ' ').trim(),
    'Agency*': opportunity.buyerAgency,
    'Department*': opportunity.buyerDepartment,
    'TAG Opportunity Phase': 'Identified',
    'TAG Pipeline Activity Phase': '',
    'Opportunity Outlook': outlook,
    'Submission Date (Response Date)*': String(opportunity.closesAt || '').slice(0, 10),
    'Solicitation Number': opportunity.referenceNumber || opportunity.requestId,
    'Notice Type': normalizeEbuyNoticeType(opportunity),
    'Priority': 'Warm',
    'Set- Aside*': opportunity.setAsideType || '-',
    'Contract Classification*': opportunity.contractType || '',
    'Contract Vehicle': vehicle,
    'Contract Vehicle Number': opportunity.vehicleSources?.join(', ') || '',
    'Contracting Officer / Specialist (POC)*': buyerContact,
    'Office*': opportunity.buyerAgency,
    'Notes*': opportunity.description || '',
  }
}

export function formatEbuyDateTime(value) {
  const date = value ? new Date(value) : null
  return date && !Number.isNaN(date.getTime())
    ? date.toLocaleString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric',
      hour: 'numeric', minute: '2-digit', hour12: true,
    })
    : 'Not provided'
}

function durationUnit(value, singular) {
  return `${value} ${singular}${value === 1 ? '' : 's'}`
}

export function formatEbuyCloseDuration(value, now = new Date()) {
  const closes = value ? new Date(value) : null
  if (!closes || Number.isNaN(closes.getTime())) return 'Closing time unavailable'
  const difference = closes.getTime() - now.getTime()
  const future = difference >= 0
  const totalMinutes = Math.max(1, Math.round(Math.abs(difference) / 60_000))
  const days = Math.floor(totalMinutes / 1_440)
  const hours = Math.floor((totalMinutes % 1_440) / 60)
  const minutes = totalMinutes % 60
  const parts = days
    ? [durationUnit(days, 'day'), ...(hours ? [durationUnit(hours, 'hour')] : [])]
    : hours
      ? [durationUnit(hours, 'hour'), ...(minutes ? [durationUnit(minutes, 'minute')] : [])]
      : [durationUnit(minutes, 'minute')]
  return future ? `Closes in ${parts.join(' ')}` : `Closed ${parts.join(' ')} ago`
}

export function formatEbuyAttachmentMeta(attachment = {}) {
  const archived = attachment.archiveStatus === 'archived'
  const failed = attachment.archiveStatus === 'error'
  const byteSize = Number(attachment.byteSize || 0)
  const size = byteSize > 0 ? `${Math.ceil(byteSize / 1024)} KB` : ''
  const status = failed ? 'Archive failed' : archived ? 'Archived' : 'Awaiting archive'
  return [size, status].filter(Boolean).join(' · ')
}

const EBUY_FIELD_LABELS = {
  requestType: 'Request type', title: 'Title', description: 'Description', referenceNumber: 'Reference number',
  buyerAgency: 'Agency', buyerDepartment: 'Department', buyerName: 'Buyer name', buyerEmail: 'Buyer email',
  buyerPhone: 'Buyer phone', setAsideType: 'Set-aside', contractType: 'Contract type', awardMethod: 'Award method',
  placeOfPerformance: 'Place of performance', performanceStates: 'Performance states', vehicleSources: 'Vehicle',
  vehicleSins: 'SINs', vehiclePairs: 'Vehicle and SIN', postedAt: 'Posted date', closesAt: 'Closing date',
  isFollowOn: 'Follow-on status', sourceDetails: 'Source details',
}

export function formatEbuyChangedField(value) {
  const key = String(value || '').trim()
  if (!key) return ''
  return EBUY_FIELD_LABELS[key] || key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replaceAll('_', ' ')
    .replace(/^./, (character) => character.toUpperCase())
}
