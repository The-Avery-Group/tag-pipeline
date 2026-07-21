/**
 * Search every user-facing value on a workbook row while excluding client-only
 * bookkeeping such as _rowIndex. Keeping this shared prevents each page from
 * silently searching a different subset of its record fields.
 */
export function searchableValues(record) {
  return Object.entries(record || {})
    .filter(([key]) => !String(key).startsWith('_'))
    .map(([, value]) => String(value ?? ''))
}

export function recordMatches(record, query) {
  const normalizedQuery = String(query || '').trim().toLowerCase()
  if (!normalizedQuery) return true
  return searchableValues(record).some((value) => value.toLowerCase().includes(normalizedQuery))
}
