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

export function buildSearchIndex(rows = [], valuesFor = searchableValues) {
  return rows.map((row) => {
    const values = valuesFor(row).map((value) => String(value ?? '').toLowerCase())
    return { row, values, text: values.join('\n') }
  })
}

export function filterSearchIndex(index, query) {
  const normalizedQuery = String(query || '').trim().toLowerCase()
  if (!normalizedQuery) return index.map(({ row }) => row)
  return index
    .filter(({ text }) => text.includes(normalizedQuery))
    .map(({ row }) => row)
}

export function rankSearchIndex(index, query) {
  const normalizedQuery = String(query || '').trim().toLowerCase()
  if (!normalizedQuery) return []
  return index
    .map((entry) => {
      const score = entry.values.reduce((best, text) => {
        if (!text.includes(normalizedQuery)) return best
        if (text === normalizedQuery) return Math.max(best, 100)
        if (text.startsWith(normalizedQuery)) return Math.max(best, 60)
        return Math.max(best, 20)
      }, 0)
      return { row: entry.row, score }
    })
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score)
    .map(({ row }) => row)
}

export function recordMatches(record, query) {
  const normalizedQuery = String(query || '').trim().toLowerCase()
  if (!normalizedQuery) return true
  return searchableValues(record).some((value) => value.toLowerCase().includes(normalizedQuery))
}
