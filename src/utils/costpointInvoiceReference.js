export const COSTPOINT_INVOICE_REFERENCE_LIMIT = 15

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
  const fields = new Set(['sequence', 'hash', 'date', 'amount'])
  rows.forEach((row) => Object.keys(row || {}).forEach((key) => fields.add(key)))
  return [...fields].sort((left, right) => left.localeCompare(right))
}

export function resolveTransactionPattern(pattern, row, sequence = 1) {
  const transactionDate = row.transactionDate || row.transaction_date || ''
  const amountCents = Number(row.amountCents ?? row.amount_cents ?? 0)
  const identity = clean(row.id || row.sourceHash || row.source_hash || sequence)
  const fields = {
    ...row,
    sequence,
    hash: stableHash(identity).toString(36),
    date: transactionDate,
    transactionDate,
    amount: (amountCents / 100).toFixed(2),
    amountCents,
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
  if (mode === 'custom') return clean(resolveTransactionPattern(pattern, row, sequence))
  return automaticInvoiceReference(row, sequence)
}
