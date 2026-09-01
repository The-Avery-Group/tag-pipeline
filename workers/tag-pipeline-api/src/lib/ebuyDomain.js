const ARRAY_FIELDS = ['performanceStates', 'vehicleSources', 'vehicleSins', 'vehiclePairs']

function cleanText(value) {
  return String(value ?? '').replace(/\r\n?/g, '\n').trim()
}

function cleanArray(value) {
  const list = Array.isArray(value) ? value : value ? [value] : []
  return [...new Set(list.map(cleanText).filter(Boolean))].sort((left, right) => left.localeCompare(right))
}

function canonicalObject(value) {
  if (Array.isArray(value)) return value.map(canonicalObject)
  if (!value || typeof value !== 'object') return typeof value === 'string' ? cleanText(value) : value
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalObject(value[key])]))
}

function materialAmendments(value) {
  return (Array.isArray(value) ? value : []).map((amendment) => canonicalObject({
    id: cleanText(amendment?.id),
    label: cleanText(amendment?.label || amendment?.title),
    description: cleanText(amendment?.description),
    postedAt: cleanText(amendment?.postedAt || amendment?.date) || null,
  })).sort((left, right) => `${left.postedAt || ''}:${left.id}:${left.label}`.localeCompare(`${right.postedAt || ''}:${right.id}:${right.label}`))
}

export function normalizeEbuyOpportunity(record, now = new Date().toISOString()) {
  const requestId = cleanText(record.requestId || record.request_id || record.id)
  if (!requestId) throw new Error('eBuy opportunity is missing a Request ID')
  const normalized = {
    sourceId: cleanText(record.id || requestId), requestId,
    requestType: cleanText(record.requestType).toUpperCase(),
    title: cleanText(record.title), description: cleanText(record.description),
    referenceNumber: cleanText(record.referenceNumber),
    buyerAgency: cleanText(record.buyerAgency), buyerDepartment: cleanText(record.buyerDepartment),
    buyerName: cleanText(record.buyerName), buyerEmail: cleanText(record.buyerEmail).toLowerCase(), buyerPhone: cleanText(record.buyerPhone),
    setAsideType: cleanText(record.setAsideType), contractType: cleanText(record.contractType), awardMethod: cleanText(record.awardMethod),
    placeOfPerformance: cleanText(record.placeOfPerformanceRaw || record.placeOfPerformance),
    postedAt: cleanText(record.postedAt) || null, closesAt: cleanText(record.closesAt) || null,
    sourceLastSeenAt: cleanText(record.lastScrapedAt) || now,
    isFollowOn: Boolean(record.isFollowOn),
    amendments: Array.isArray(record.amendments) ? record.amendments : [],
    attachments: Array.isArray(record.attachments) ? record.attachments : [],
    attachmentReferences: record.attachmentReferences && typeof record.attachmentReferences === 'object'
      ? record.attachmentReferences
      : { mentioned: false, missing: [] },
    sourceDetails: record.sourceDetails && typeof record.sourceDetails === 'object' ? record.sourceDetails : {},
  }
  for (const field of ARRAY_FIELDS) normalized[field] = cleanArray(record[field])
  return normalized
}

export function stableEbuySnapshot(record) {
  const normalized = normalizeEbuyOpportunity(record, 'source-controlled')
  // This is deliberately an allow-list. eBuy sourceDetails contains request
  // metadata, scrape diagnostics, token/session values, and ordering details
  // that can change between identical pulls. None of those are opportunity
  // record changes and therefore must never manufacture a history entry.
  return {
    requestType: normalized.requestType,
    title: normalized.title,
    description: normalized.description,
    referenceNumber: normalized.referenceNumber,
    buyerAgency: normalized.buyerAgency,
    buyerDepartment: normalized.buyerDepartment,
    buyerName: normalized.buyerName,
    buyerEmail: normalized.buyerEmail,
    buyerPhone: normalized.buyerPhone,
    setAsideType: normalized.setAsideType,
    contractType: normalized.contractType,
    awardMethod: normalized.awardMethod,
    placeOfPerformance: normalized.placeOfPerformance,
    performanceStates: normalized.performanceStates,
    vehicleSources: normalized.vehicleSources,
    vehicleSins: normalized.vehicleSins,
    vehiclePairs: normalized.vehiclePairs,
    postedAt: normalized.postedAt,
    closesAt: normalized.closesAt,
    isFollowOn: normalized.isFollowOn,
    amendments: materialAmendments(normalized.amendments),
  }
}

export async function hashEbuyOpportunity(record) {
  const bytes = new TextEncoder().encode(JSON.stringify(stableEbuySnapshot(record)))
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

export function changedEbuyFields(previous, next) {
  if (!previous) return Object.keys(stableEbuySnapshot(next))
  const before = stableEbuySnapshot(previous)
  const after = stableEbuySnapshot(next)
  return Object.keys(after).filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]))
}

export function retentionDeadline(state, lifecycle, now = new Date(), settings = {}) {
  const days = state === 'dismissed'
    ? 30
    : lifecycle === 'expired'
      ? Number(settings.expiredRetentionDays || 90)
      : lifecycle === 'unavailable'
        ? Number(settings.unavailableRetentionDays || 30)
        : 0
  if (!days || ['flagged', 'tracked', 'added_to_pipeline'].includes(state)) return null
  return new Date(now.getTime() + days * 86_400_000).toISOString()
}

export function lifecycleForEbuyOpportunity(record, now = new Date()) {
  const closes = record.closesAt ? new Date(record.closesAt) : null
  return closes && !Number.isNaN(closes.getTime()) && closes < now ? 'expired' : 'active'
}
