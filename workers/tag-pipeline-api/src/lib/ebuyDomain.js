const ARRAY_FIELDS = ['performanceStates', 'vehicleSources', 'vehicleSins', 'vehiclePairs']

function cleanText(value) {
  return String(value ?? '').trim()
}

function cleanArray(value) {
  const list = Array.isArray(value) ? value : value ? [value] : []
  return [...new Set(list.map(cleanText).filter(Boolean))]
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
    sourceDetails: record.sourceDetails && typeof record.sourceDetails === 'object' ? record.sourceDetails : {},
  }
  for (const field of ARRAY_FIELDS) normalized[field] = cleanArray(record[field])
  return normalized
}

export function stableEbuySnapshot(record) {
  const normalized = normalizeEbuyOpportunity(record, 'source-controlled')
  delete normalized.sourceLastSeenAt
  delete normalized.amendments
  delete normalized.attachments
  return normalized
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
    ? Number(settings.dismissedRetentionDays || 30)
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
