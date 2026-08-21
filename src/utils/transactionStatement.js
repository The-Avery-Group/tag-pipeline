import { strFromU8, unzipSync } from 'fflate'

const HEADER_ALIASES = {
  transactionDate: ['date', 'transaction date', 'posted date', 'posting date', 'trans date'],
  rawDescription: ['transaction', 'description', 'transaction description', 'details', 'memo', 'merchant description'],
  normalizedMerchant: ['merchant', 'vendor', 'payee', 'merchant name'],
  location: ['location', 'address', 'merchant location'],
  city: ['city', 'merchant city'],
  amount: ['amount', 'transaction amount', 'charge amount', 'total'],
  debit: ['debit', 'debits', 'charge', 'charges'],
  credit: ['credit', 'credits', 'refund', 'refunds'],
}

const canonical = (value) => String(value ?? '').trim().toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ')

export function parseDelimitedText(text) {
  const first = String(text || '').split(/\r?\n/, 1)[0] || ''
  const delimiter = [',', '\t', ';'].sort((a, b) => first.split(b).length - first.split(a).length)[0]
  const rows = []
  let row = [], cell = '', quoted = false
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]
    if (quoted && char === '"' && text[i + 1] === '"') { cell += '"'; i += 1 }
    else if (char === '"') quoted = !quoted
    else if (!quoted && char === delimiter) { row.push(cell.trim()); cell = '' }
    else if (!quoted && (char === '\n' || char === '\r')) {
      if (char === '\r' && text[i + 1] === '\n') i += 1
      row.push(cell.trim()); cell = ''
      if (row.some(Boolean)) rows.push(row)
      row = []
    } else cell += char
  }
  row.push(cell.trim())
  if (row.some(Boolean)) rows.push(row)
  return rows
}

function xmlText(value) {
  return String(value || '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
}

function columnIndex(ref) {
  return (String(ref).match(/[A-Z]+/i)?.[0] || 'A').toUpperCase().split('').reduce((n, letter) => n * 26 + letter.charCodeAt(0) - 64, 0) - 1
}

function xlsxRows(buffer) {
  const archive = unzipSync(new Uint8Array(buffer))
  const sharedXml = archive['xl/sharedStrings.xml'] ? strFromU8(archive['xl/sharedStrings.xml']) : ''
  const shared = [...sharedXml.matchAll(/<si[^>]*>([\s\S]*?)<\/si>/g)].map((match) =>
    xmlText([...match[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((part) => part[1]).join('')))
  const sheetKey = Object.keys(archive).find((key) => /^xl\/worksheets\/sheet\d+\.xml$/.test(key))
  if (!sheetKey) throw new Error('The workbook does not contain a readable worksheet.')
  const xml = strFromU8(archive[sheetKey])
  return [...xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)].map((rowMatch) => {
    const values = []
    for (const match of rowMatch[1].matchAll(/<c([^>]*)>([\s\S]*?)<\/c>/g)) {
      const attributes = match[1]
      const body = match[2]
      const ref = attributes.match(/\br="([^"]+)"/)?.[1] || 'A1'
      const type = attributes.match(/\bt="([^"]+)"/)?.[1] || ''
      const raw = body.match(/<v>([\s\S]*?)<\/v>/)?.[1]
        ?? body.match(/<t[^>]*>([\s\S]*?)<\/t>/)?.[1] ?? ''
      values[columnIndex(ref)] = type === 's' ? (shared[Number(raw)] || '') : xmlText(raw)
    }
    return values.map((value) => String(value ?? '').trim())
  }).filter((row) => row.some(Boolean))
}

function findHeader(rows) {
  let best = { index: -1, score: 0, mapping: {} }
  rows.slice(0, 15).forEach((row, index) => {
    const mapping = {}
    row.forEach((header, column) => {
      const normalized = canonical(header)
      Object.entries(HEADER_ALIASES).forEach(([field, aliases]) => {
        if (mapping[field] == null && aliases.includes(normalized)) mapping[field] = column
      })
    })
    const score = Object.keys(mapping).length + (mapping.rawDescription != null ? 3 : 0) + ((mapping.amount ?? mapping.debit ?? mapping.credit) != null ? 3 : 0)
    if (score > best.score) best = { index, score, mapping }
  })
  return best
}

export function detectStatementMapping(headers = []) {
  const mapping = {}
  headers.forEach((header, column) => {
    const normalized = canonical(header)
    Object.entries(HEADER_ALIASES).forEach(([field, aliases]) => {
      if (mapping[field] == null && aliases.includes(normalized)) mapping[field] = column
    })
  })
  return mapping
}

function amountNumber(value) {
  const text = String(value ?? '').trim()
  if (!text) return null
  const negative = /^\(.*\)$/.test(text) || /-$/.test(text)
  const number = Number(text.replace(/[$,()]/g, '').replace(/-$/, ''))
  return Number.isFinite(number) ? (negative ? -Math.abs(number) : number) : null
}

function isoDate(value) {
  const text = String(value ?? '').trim()
  if (!text) return ''
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0, 10)
  const excel = Number(text)
  if (Number.isFinite(excel) && excel > 20_000 && excel < 100_000) return new Date(Date.UTC(1899, 11, 30) + excel * 86_400_000).toISOString().slice(0, 10)
  const date = new Date(text)
  return Number.isNaN(date.getTime()) ? text : date.toISOString().slice(0, 10)
}

function merchantFrom(description) {
  return String(description || '').replace(/\s+(?:\*|#)?\d{5,}\b.*$/i, '').replace(/\s{2,}/g, ' ').trim()
}

async function digest(value) {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value
  const hash = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

export async function inspectTransactionStatement(file) {
  const buffer = await file.arrayBuffer()
  const lowerName = file.name.toLowerCase()
  const sourceRows = lowerName.endsWith('.csv') || lowerName.endsWith('.txt')
    ? parseDelimitedText(new TextDecoder().decode(buffer))
    : xlsxRows(buffer)
  if (!sourceRows.length) throw new Error('The statement does not contain any readable rows.')
  const detected = findHeader(sourceRows)
  const headerIndex = detected.index >= 0 ? detected.index : 0
  return {
    fileName: file.name,
    fileHash: await digest(buffer),
    sourceRows,
    headerIndex,
    headers: sourceRows[headerIndex] || [],
    mapping: detected.mapping,
  }
}

export async function normalizeTransactionInspection(inspection, options = {}) {
  const sourceRows = inspection?.sourceRows || []
  const headerIndex = Number.isInteger(options.headerIndex) ? options.headerIndex : inspection.headerIndex
  const mapping = options.mapping || inspection.mapping || {}
  if (mapping.rawDescription == null || (mapping.amount == null && mapping.debit == null && mapping.credit == null)) {
    throw new Error('Choose a Description column and either an Amount column or Debit and Credit columns.')
  }
  const seen = new Map()
  let skippedCount = 0
  const prepared = []
  for (let index = headerIndex + 1; index < sourceRows.length; index += 1) {
    const source = sourceRows[index]
    const description = String(source[mapping.rawDescription] || '').trim()
    if (!description || /^(total(?: new charges)?|ending balance|beginning balance)$/i.test(description)) { skippedCount += 1; continue }
    let amount = mapping.amount != null ? amountNumber(source[mapping.amount]) : null
    if (amount == null && mapping.debit != null) amount = Math.abs(amountNumber(source[mapping.debit]) || 0)
    if (amount == null && mapping.credit != null) amount = -Math.abs(amountNumber(source[mapping.credit]) || 0)
    if (!amount) { skippedCount += 1; continue }
    const transactionDate = isoDate(source[mapping.transactionDate])
    const location = String(source[mapping.location] || '').trim()
    const city = String(source[mapping.city] || '').trim()
    const key = `${transactionDate}|${description}|${location}|${city}|${amount}`
    const occurrence = (seen.get(key) || 0) + 1
    seen.set(key, occurrence)
    prepared.push({
      sourceRow: index + 1,
      sourceKey: `${key}|${occurrence}`,
      transactionDate,
      rawDescription: description,
      normalizedMerchant: String(source[mapping.normalizedMerchant] || '').trim() || merchantFrom(description),
      location,
      city,
      amountCents: Math.round(amount * 100),
      direction: amount < 0 ? 'credit' : 'charge',
    })
  }
  if (!prepared.length) throw new Error('No transaction rows were found in this statement.')
  const rows = await Promise.all(prepared.map(async ({ sourceKey, ...row }) => ({ ...row, sourceHash: await digest(sourceKey) })))
  return {
    fileName: inspection.fileName,
    fileHash: inspection.fileHash,
    rows,
    sourceRowCount: sourceRows.length - headerIndex - 1,
    skippedCount,
    headerIndex,
    mapping,
    mappedHeaders: Object.fromEntries(Object.entries(mapping).map(([field, column]) => [field, sourceRows[headerIndex]?.[column] || ''])),
  }
}

export async function parseTransactionStatement(file, options = {}) {
  const inspection = await inspectTransactionStatement(file)
  return normalizeTransactionInspection(inspection, options)
}
