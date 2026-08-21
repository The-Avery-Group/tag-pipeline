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

export function csvEscape(value) {
  const text = String(value ?? '')
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

export const NEUTRAL_EXPORT_HEADERS = [
  'Transaction ID', 'Transaction Date', 'Description', 'Location', 'City',
  'Amount', 'Transaction Type', 'Vendor', 'Vendor ID', 'Project', 'Account', 'Organization',
]

export function buildNeutralExportCsv(rows = []) {
  const lines = [NEUTRAL_EXPORT_HEADERS]
  rows.forEach((row) => lines.push([
    row.id,
    row.transaction_date ?? row.transactionDate,
    row.raw_description ?? row.rawDescription,
    row.location,
    row.city,
    ((Number(row.amount_cents ?? row.amountCents) || 0) / 100).toFixed(2),
    row.direction,
    row.vendor,
    row.vendor_id ?? row.vendorId,
    row.project,
    row.account,
    row.organization,
  ]))
  return `${lines.map((line) => line.map(csvEscape).join(',')).join('\r\n')}\r\n`
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
