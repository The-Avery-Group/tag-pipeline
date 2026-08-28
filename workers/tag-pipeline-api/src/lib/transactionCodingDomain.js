const RULE_FIELDS = ['vendor', 'vendorId', 'project', 'account', 'organization']

export function cleanText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim()
}

export function normalizedSearchText(value) {
  return cleanText(value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .trim()
    .toLowerCase()
}

export function publicRule(row = {}) {
  return {
    id: cleanText(row.id || row['Rule ID']),
    active: !['no', 'false', '0', 'inactive'].includes(cleanText(row.active ?? row.Active).toLowerCase()),
    priority: Number(row.priority ?? row.Priority ?? 100) || 100,
    matchType: cleanText(row.match_type || row.matchType || row['Match Type'] || 'contains').toLowerCase().replace(/\s+/g, '_'),
    matchPattern: cleanText(row.match_pattern || row.matchPattern || row['Match Pattern']),
    vendor: cleanText(row.vendor || row.Vendor),
    vendorId: cleanText(row.vendor_id || row.vendorId || row['Vendor ID']),
    project: cleanText(row.project || row.Project),
    account: cleanText(row.account || row.Account),
    organization: cleanText(row.organization || row.Organization),
    context: cleanText(row.context || row.Context),
    notes: cleanText(row.notes || row.Notes),
    source: cleanText(row.source) || 'workbook',
    updatedBy: cleanText(row.updated_by || row.updatedBy || row['Updated By']),
    updatedAt: cleanText(row.updated_at || row.updatedAt || row['Last Updated']),
  }
}

function matches(rule, description) {
  const haystack = normalizedSearchText(description)
  const needle = normalizedSearchText(rule.matchPattern)
  if (!haystack || !needle) return false
  if (rule.matchType === 'exact') return haystack === needle
  if (rule.matchType === 'starts_with' || rule.matchType === 'starts with') return haystack.startsWith(needle)
  if (rule.matchType === 'whole_word' || rule.matchType === 'whole word') {
    return haystack === needle || haystack.startsWith(`${needle} `) || haystack.endsWith(` ${needle}`) || haystack.includes(` ${needle} `)
  }
  if (rule.matchType === 'regex') {
    try { return new RegExp(rule.matchPattern, 'i').test(cleanText(description)) } catch { return false }
  }
  return haystack.includes(needle)
}

export function transactionStatus(values = {}) {
  const populated = RULE_FIELDS.filter((field) => cleanText(values[field])).length
  if (populated === RULE_FIELDS.length) return 'ready'
  return populated > 0 ? 'review' : 'uncategorized'
}

export function categorizeTransaction(transaction, rules = []) {
  const description = [transaction.rawDescription, transaction.location, transaction.city]
    .map(cleanText).filter(Boolean).join(' ')
  const ordered = rules.map(publicRule)
    .filter((rule) => rule.active && rule.matchPattern)
    .sort((left, right) => right.priority - left.priority || right.matchPattern.length - left.matchPattern.length)
  const rule = ordered.find((candidate) => matches(candidate, description)) || null
  if (!rule) return { ...transaction, status: 'uncategorized', confidence: 'none', ruleId: null }
  const result = {
    ...transaction,
    vendor: rule.vendor,
    vendorId: rule.vendorId,
    project: rule.project,
    account: rule.account,
    organization: rule.organization,
    ruleId: rule.id || null,
  }
  result.status = transactionStatus(result)
  result.confidence = result.status === 'ready' ? 'rule' : 'partial'
  return result
}

export const COSTPOINT_HEADER_FIELD_COUNT = 40
export const COSTPOINT_DETAIL_FIELD_COUNT = 164
export const COSTPOINT_INVOICE_REFERENCE_LIMIT = 15

function rowValue(row, snakeKey, camelKey = snakeKey) {
  return row?.[snakeKey] ?? row?.[camelKey]
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

function transactionFields(row, sequence) {
  const fields = { ...row }
  const transactionDate = rowValue(row, 'transaction_date', 'transactionDate') || ''
  const amountCents = Number(rowValue(row, 'amount_cents', 'amountCents') || 0)
  const identity = cleanText(row?.id || rowValue(row, 'source_hash', 'sourceHash') || sequence)
  return {
    ...fields,
    sequence,
    hash: stableHash(identity).toString(36),
    date: transactionDate,
    transactionDate,
    amount: (amountCents / 100).toFixed(2),
    amountCents,
  }
}

export function resolveInvoiceReferencePattern(pattern, row, sequence = 1) {
  const fields = transactionFields(row, sequence)
  const exact = new Map(Object.entries(fields).map(([key, value]) => [key, value]))
  const normalized = new Map(Object.entries(fields).map(([key, value]) => [normalizedFieldName(key), value]))
  const missing = []
  const reference = String(pattern ?? '').replace(/\{([^{}]+)\}/g, (token, rawName) => {
    const name = rawName.trim()
    if (exact.has(name)) return String(exact.get(name) ?? '')
    const normalizedName = normalizedFieldName(name)
    if (normalized.has(normalizedName)) return String(normalized.get(normalizedName) ?? '')
    missing.push(name)
    return token
  })
  if (missing.length) {
    throw new Error(`Invoice reference field ${missing.map((name) => `{${name}}`).join(', ')} is not available on transaction ${cleanText(row?.id) || sequence}.`)
  }
  return reference
}

function automaticInvoiceReference(row, sequence) {
  const date = cleanText(rowValue(row, 'transaction_date', 'transactionDate')).replace(/[^0-9]/g, '').slice(2, 8) || '000000'
  const identity = cleanText(row?.id || rowValue(row, 'source_hash', 'sourceHash') || sequence)
  return `TC${date}${stableHash(identity).toString(36).toUpperCase().padStart(7, '0').slice(-7)}`
}

function transactionIdReference(row, sequence) {
  const identity = cleanText(row?.id || rowValue(row, 'source_hash', 'sourceHash') || sequence)
  return identity.replace(/[^a-zA-Z0-9._ -]/g, '').trim().slice(0, COSTPOINT_INVOICE_REFERENCE_LIMIT)
}

function invoiceReferenceFor(row, sequence, options) {
  const overrides = options.invoiceReferences || {}
  if (Object.prototype.hasOwnProperty.call(overrides, row.id)) return cleanText(overrides[row.id])
  const mode = cleanText(options.invoiceReferenceMode || 'automatic').toLowerCase()
  if (mode === 'manual') return ''
  if (mode === 'transaction_id') return transactionIdReference(row, sequence)
  if (mode === 'custom') return cleanText(resolveInvoiceReferencePattern(options.invoiceReferencePattern || '', row, sequence))
  return automaticInvoiceReference(row, sequence)
}

function requireCostpointText(value, label, limit, transactionLabel) {
  const text = cleanText(value)
  if (!text) throw new Error(`${label} is required for ${transactionLabel}.`)
  if (text.length > limit) throw new Error(`${label} for ${transactionLabel} exceeds Costpoint's ${limit}-character limit.`)
  if (/[,\r\n]/.test(String(value ?? ''))) throw new Error(`${label} for ${transactionLabel} cannot contain commas or line breaks.`)
  return text
}

function costpointDate(value, transactionLabel) {
  const text = cleanText(value)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || Number.isNaN(Date.parse(`${text}T00:00:00Z`))) {
    throw new Error(`A valid transaction date in YYYY-MM-DD format is required for ${transactionLabel}.`)
  }
  return text
}

function lineDescription(value) {
  return cleanText(String(value ?? '').replace(/,/g, ' ')).slice(0, 30)
}

function voucherNumber(row, sequence, used, overrides = {}) {
  if (Object.prototype.hasOwnProperty.call(overrides, row.id)) {
    const override = cleanText(overrides[row.id])
    if (!/^\d{1,9}$/.test(override)) throw new Error(`Costpoint transaction ID for ${cleanText(row.raw_description ?? row.rawDescription) || row.id} must contain 1 to 9 digits.`)
    if (used.has(override)) throw new Error(`Costpoint transaction ID “${override}” is duplicated in this export.`)
    used.add(override)
    return override
  }
  const identity = cleanText(row?.id || rowValue(row, 'source_hash', 'sourceHash') || sequence)
  let candidate = String(stableHash(identity) % 1_000_000_000).padStart(9, '0')
  while (used.has(candidate)) candidate = String((Number(candidate) + 1) % 1_000_000_000).padStart(9, '0')
  used.add(candidate)
  return candidate
}

export function buildCostpointApVoucherCsv(rows = [], options = {}) {
  if (!Array.isArray(rows) || !rows.length) throw new Error('Select at least one transaction to export.')
  const usedReferences = new Set()
  const usedVoucherNumbers = new Set()
  const invoiceReferences = {}
  const inputVoucherNumbers = {}
  const records = []

  rows.forEach((row, index) => {
    const sequence = index + 1
    const transactionLabel = cleanText(row.raw_description ?? row.rawDescription) || cleanText(row.id) || `transaction ${sequence}`
    const invoiceReference = requireCostpointText(
      invoiceReferenceFor(row, sequence, options),
      'Invoice reference',
      COSTPOINT_INVOICE_REFERENCE_LIMIT,
      transactionLabel,
    )
    const normalizedReference = invoiceReference.toLowerCase()
    if (usedReferences.has(normalizedReference)) throw new Error(`Invoice reference “${invoiceReference}” is duplicated in this export.`)
    usedReferences.add(normalizedReference)
    invoiceReferences[row.id] = invoiceReference

    const transactionDate = costpointDate(rowValue(row, 'transaction_date', 'transactionDate'), transactionLabel)
    const vendorId = requireCostpointText(rowValue(row, 'vendor_id', 'vendorId'), 'Vendor ID', 12, transactionLabel)
    const account = requireCostpointText(row.account, 'Account', 15, transactionLabel)
    const organization = requireCostpointText(row.organization, 'Organization', 20, transactionLabel)
    const project = requireCostpointText(row.project, 'Project', 30, transactionLabel)
    const amountCents = Number(rowValue(row, 'amount_cents', 'amountCents'))
    if (!Number.isInteger(amountCents) || amountCents === 0) throw new Error(`A non-zero amount is required for ${transactionLabel}.`)
    const formattedAmount = (amountCents / 100).toFixed(2)
    const inputVoucherNumber = voucherNumber(row, sequence, usedVoucherNumbers, options.inputVoucherNumbers)
    inputVoucherNumbers[row.id] = inputVoucherNumber

    const header = Array(COSTPOINT_HEADER_FIELD_COUNT).fill('')
    header[0] = 'H'
    header[1] = inputVoucherNumber
    header[5] = vendorId
    header[7] = invoiceReference
    header[8] = transactionDate
    header[9] = formattedAmount
    header[14] = 'N'

    const detail = Array(COSTPOINT_DETAIL_FIELD_COUNT).fill('')
    detail[0] = 'D'
    detail[1] = inputVoucherNumber
    detail[3] = '1'
    detail[4] = account
    detail[5] = organization
    detail[6] = project
    detail[9] = formattedAmount
    detail[10] = 'N'
    detail[12] = '0.00'
    detail[13] = '0.00'
    detail[14] = '0.00'
    detail[18] = lineDescription(row.raw_description ?? row.rawDescription)
    records.push(header, detail)
  })

  return {
    csv: `${records.map((record) => record.join(',')).join('\r\n')}\r\n`,
    invoiceReferences,
    inputVoucherNumbers,
  }
}

export function ruleWorkbookRow(rule, actor = '') {
  const normalized = publicRule({ ...rule, updatedBy: actor || rule.updatedBy })
  return [
    normalized.id,
    normalized.active ? 'Yes' : 'No',
    normalized.priority,
    normalized.matchType,
    normalized.matchPattern,
    normalized.vendor,
    normalized.vendorId,
    normalized.project,
    normalized.account,
    normalized.organization,
    normalized.context,
    normalized.notes,
    normalized.updatedAt || new Date().toISOString(),
    normalized.updatedBy || actor,
  ]
}
