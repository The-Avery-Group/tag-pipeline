import test from 'node:test'
import assert from 'node:assert/strict'
import { strFromU8, unzipSync } from 'fflate'
import { buildNeutralExportCsv, categorizeTransaction } from '../src/lib/transactionCodingDomain.js'
import { alignTransactionRuleValues, buildTransactionCodingWorkbook, RULE_HEADERS } from '../src/lib/transactionCodingSharePoint.js'
import { attemptTransactionRuleSync } from '../src/handlers/transactionCoding.js'
import { transactionCodingStorageReady } from '../src/lib/transactionCodingRepository.js'

test('categorizes a statement row with the highest-priority matching rule', () => {
  const row = categorizeTransaction({ rawDescription: 'SCRIBD *662092010', amountCents: 1299 }, [
    { id: 'broad', active: true, priority: 10, matchPattern: 'SCRIBD', vendor: 'Wrong' },
    { id: 'specific', active: true, priority: 100, matchPattern: 'SCRIBD', vendor: 'Scribd', vendorId: 'V-1', project: 'GENAD.001', account: '840-010', organization: '1.01.90.01' },
  ])
  assert.equal(row.ruleId, 'specific')
  assert.equal(row.status, 'ready')
})

test('neutral export contains coding fields without a Costpoint-specific schema', () => {
  const csv = buildNeutralExportCsv([{ id: 'txn-1', transactionDate: '2026-08-01', rawDescription: 'SCRIBD', amountCents: 1299, direction: 'charge', vendor: 'Scribd', vendorId: 'V-1', project: 'P1', account: 'A1', organization: 'O1' }])
  assert.match(csv, /Transaction ID,Transaction Date,Description/)
  assert.match(csv, /txn-1,2026-08-01,SCRIBD/)
  assert.doesNotMatch(csv.split('\r\n')[0], /Merchant/)
  assert.doesNotMatch(csv, /Costpoint/i)
})

test('generated workbook contains the rules, exports, and settings tables', () => {
  const archive = unzipSync(buildTransactionCodingWorkbook())
  const files = Object.keys(archive)
  assert.ok(files.includes('xl/tables/table1.xml'))
  assert.ok(files.includes('xl/tables/table2.xml'))
  assert.ok(files.includes('xl/tables/table3.xml'))
  assert.doesNotMatch(strFromU8(archive['xl/tables/table1.xml']), /name="Merchant"/)
})

test('rule writes follow the workbook columns after a column is removed', () => {
  const values = ['rule-1', 'Yes', 100, 'contains', 'SCRIBD', 'Scribd', 'V-1', 'P1', 'A1', 'O1', '', '', '2026-08-21', 'Ayo']
  const reducedHeaders = RULE_HEADERS.filter((header) => header !== 'Context')
  const aligned = alignTransactionRuleValues(reducedHeaders, values)
  assert.equal(aligned.length, reducedHeaders.length)
  assert.equal(aligned[reducedHeaders.indexOf('Vendor')], 'Scribd')
  assert.equal(aligned[reducedHeaders.indexOf('Updated By')], 'Ayo')
})

test('a temporary SharePoint rule-sync failure does not block statement import', async () => {
  const warning = await attemptTransactionRuleSync(async () => {
    throw new Error('Workbook session is temporarily unavailable')
  })
  assert.match(warning, /imported using the last saved categorization rules/i)
})

test('transaction coding storage requires the complete migration', async () => {
  const db = {
    prepare() {
      return {
        bind() {
          return {
            async all() {
              return {
                results: [
                  { name: 'transaction_coding_batches' },
                  { name: 'transaction_coding_transactions' },
                  { name: 'transaction_coding_rules' },
                  { name: 'transaction_coding_exports' },
                ],
              }
            },
          }
        },
      }
    },
  }
  assert.equal(await transactionCodingStorageReady(db), false)
})
