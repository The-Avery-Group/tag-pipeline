import test from 'node:test'
import assert from 'node:assert/strict'
import {
  detectStatementMapping,
  inspectTransactionStatement,
  normalizeTransactionInspection,
  parseDelimitedText,
  parseTransactionStatement,
} from '../src/utils/transactionStatement.js'

test('retired Merchant, Debit, and Credit columns are not offered for mapping', () => {
  const mapping = detectStatementMapping(['Date', 'Description', 'Merchant', 'Debit', 'Credit', 'Amount'])
  assert.deepEqual(mapping, { transactionDate: 0, rawDescription: 1, amount: 5 })
})

test('parses quoted statement descriptions without splitting embedded commas', () => {
  const rows = parseDelimitedText('Date,Description,Amount\n08/01/2026,"HOTEL, ATLANTA",129.40\n')
  assert.deepEqual(rows, [
    ['Date', 'Description', 'Amount'],
    ['08/01/2026', 'HOTEL, ATLANTA', '129.40'],
  ])
})

test('recognizes semicolon-delimited statement files', () => {
  const rows = parseDelimitedText('Posting Date;Transaction;Amount\n2026-08-01;SCRIBD;12.99')
  assert.equal(rows[1][1], 'SCRIBD')
  assert.equal(rows[1][2], '12.99')
})

test('turns a sample statement into normalized import rows', async () => {
  const file = new File([
    'DATE,TRANSACTION,LOCATION,CITY,AMOUNT\n',
    '08/01/2026,SCRIBD *662092010,ONLINE,NEW YORK,12.99\n',
    '08/02/2026,"HOTEL, ATLANTA",PEACHTREE ST,ATLANTA,250.00\n',
    ',Total New Charges,,,262.99\n',
  ], 'sample-statement.csv', { type: 'text/csv' })
  const parsed = await parseTransactionStatement(file)
  assert.equal(parsed.rows.length, 2)
  assert.equal(parsed.rows[1].amountCents, 25000)
  assert.equal(parsed.skippedCount, 1)
  assert.match(parsed.fileHash, /^[a-f0-9]{64}$/)
})

test('allows unfamiliar statement columns to be recalibrated before import', async () => {
  const file = new File([
    'Report generated for August\n',
    'When,What happened,Money out\n',
    '08/03/2026,COMCAST CABLE,89.00\n',
  ], 'unfamiliar.csv', { type: 'text/csv' })
  const inspection = await inspectTransactionStatement(file)
  await assert.rejects(() => normalizeTransactionInspection(inspection), /Choose a Description column/)
  const normalized = await normalizeTransactionInspection(inspection, {
    headerIndex: 1,
    mapping: { transactionDate: 0, rawDescription: 1, amount: 2 },
  })
  assert.equal(normalized.rows.length, 1)
  assert.equal(normalized.rows[0].rawDescription, 'COMCAST CABLE')
  assert.equal(normalized.rows[0].amountCents, 8900)
})
