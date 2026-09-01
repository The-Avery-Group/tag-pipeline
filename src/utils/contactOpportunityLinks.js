export const PIPELINE_POC_FIELD = 'Contracting Officer / Specialist (POC)*'

export function parsePOCNames(pocValue) {
  if (!pocValue) return []
  return String(pocValue).split(',').map((name) => name.trim()).filter(Boolean)
}

export function normalizeLinkedContactName(value) {
  return String(value || '')
    .normalize('NFKC')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLocaleLowerCase()
}

export function opportunityHasLinkedContact(opportunity, contactName, pocField = PIPELINE_POC_FIELD) {
  const expected = normalizeLinkedContactName(contactName)
  if (!expected) return false
  return parsePOCNames(opportunity?.[pocField]).some(
    (name) => normalizeLinkedContactName(name) === expected
  )
}

export function findOpportunitiesForContact(pipeline, contactName, pocField = PIPELINE_POC_FIELD) {
  return (Array.isArray(pipeline) ? pipeline : []).filter(
    (opportunity) => opportunityHasLinkedContact(opportunity, contactName, pocField)
  )
}
