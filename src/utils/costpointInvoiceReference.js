export const COSTPOINT_INVOICE_REFERENCE_LIMIT = 15
export const DEFAULT_INVOICE_REFERENCE_PATTERN = 'INV-{date}-{sequence}'
export const COMPACT_INVOICE_REFERENCE_PATTERN = 'INV{date}{sequence}'
export const INVOICE_REFERENCE_PATTERN_FIELDS = Object.freeze(['date', 'sequence'])

function clean(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim()
}

function stableHash(value) {
  let hash = 2166136261
  const text = String(value ?? '')
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

function normalizedFieldName(value) {
  return String(value ?? '').replace(/[^a-zA-Z0-9]/g, '').toLowerCase()
}

export function availableTransactionFields(rows = []) {
  const fields = new Set(INVOICE_REFERENCE_PATTERN_FIELDS)
  rows.forEach((row) => Object.keys(row || {}).forEach((key) => fields.add(key)))
  return [...fields].sort((left, right) => left.localeCompare(right))
}

export function validateTransactionPattern(pattern) {
  const fields = [...String(pattern ?? '').matchAll(/\{([^{}]+)\}/g)].map((match) => match[1].trim())
  const invalid = fields.filter((field) => !['date', 'sequence'].includes(field))
  if (invalid.length) throw new Error(`Unavailable field: ${[...new Set(invalid)].map((name) => `{${name}}`).join(', ')}`)
  if (!fields.length) {
    throw new Error('Custom patterns must include {date}, {sequence}, or both.')
  }
  return true
}

function sequenceNumber(value) {
  const numeric = Math.floor(Number(value))
  return Number.isInteger(numeric) && numeric > 0 ? numeric : 1
}

export function invoiceReferenceSequencePlan(rows = [], {
  scope = 'statement',
  start = 1,
  nextByMonth = {},
} = {}) {
  const ordered = [...rows].sort((left, right) => (
    String(left.transactionDate || left.transaction_date || '').localeCompare(String(right.transactionDate || right.transaction_date || ''))
    || Number(left.sourceRow || left.source_row || 0) - Number(right.sourceRow || right.source_row || 0)
    || String(left.id || '').localeCompare(String(right.id || ''))
  ))
  const first = sequenceNumber(start)
  const counters = new Map()
  const sequences = {}
  ordered.forEach((row, index) => {
    const month = String(row.transactionDate || row.transaction_date || '').slice(0, 7)
    if (scope === 'monthly') {
      const current = counters.has(month)
        ? counters.get(month)
        : Math.max(first, sequenceNumber(nextByMonth?.[month] || first))
      sequences[row.id] = current
      counters.set(month, current + 1)
    } else {
      sequences[row.id] = first + index
    }
  })
  return {
    sequences,
    maximum: Math.max(0, ...Object.values(sequences)),
  }
}

export function resolveTransactionPattern(pattern, row, sequence = 1) {
  const transactionDate = row.transactionDate || row.transaction_date || ''
  const fields = {
    ...row,
    sequence: String(sequenceNumber(sequence)).padStart(3, '0'),
    date: String(transactionDate).slice(0, 7),
  }
  const exact = new Map(Object.entries(fields))
  const normalized = new Map(Object.entries(fields).map(([key, value]) => [normalizedFieldName(key), value]))
  const missing = []
  const value = String(pattern ?? '').replace(/\{([^{}]+)\}/g, (token, rawName) => {
    const name = rawName.trim()
    if (exact.has(name)) return String(exact.get(name) ?? '')
    const normalizedName = normalizedFieldName(name)
    if (normalized.has(normalizedName)) return String(normalized.get(normalizedName) ?? '')
    missing.push(name)
    return token
  })
  if (missing.length) throw new Error(`Unavailable field: ${missing.map((name) => `{${name}}`).join(', ')}`)
  return value
}

export function automaticInvoiceReference(row, sequence = 1) {
  const date = clean(row.transactionDate || row.transaction_date).replace(/[^0-9]/g, '').slice(2, 8) || '000000'
  const identity = clean(row.id || row.sourceHash || row.source_hash || sequence)
  return `TC${date}${stableHash(identity).toString(36).toUpperCase().padStart(7, '0').slice(-7)}`
}

export function transactionIdInvoiceReference(row, sequence = 1) {
  const identity = clean(row.id || row.sourceHash || row.source_hash || sequence)
  return identity.replace(/[^a-zA-Z0-9._ -]/g, '').trim().slice(0, COSTPOINT_INVOICE_REFERENCE_LIMIT)
}

export function defaultInputVoucherNumber(row, sequence = 1, used = new Set()) {
  const identity = clean(row.id || row.sourceHash || row.source_hash || sequence)
  let candidate = String(stableHash(identity) % 1_000_000_000).padStart(9, '0')
  while (used.has(candidate)) candidate = String((Number(candidate) + 1) % 1_000_000_000).padStart(9, '0')
  used.add(candidate)
  return candidate
}

export function invoiceReferenceForMode(row, sequence, mode, pattern = '') {
  if (mode === 'manual') return ''
  if (mode === 'transaction_id') return transactionIdInvoiceReference(row, sequence)
  if (mode === 'custom') {
    validateTransactionPattern(pattern)
    return clean(resolveTransactionPattern(pattern, row, sequence))
  }
  return automaticInvoiceReference(row, sequence)
}
