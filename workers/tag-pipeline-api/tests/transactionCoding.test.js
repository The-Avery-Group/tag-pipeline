import test from 'node:test'
import assert from 'node:assert/strict'
import { strFromU8, unzipSync } from 'fflate'
import { buildNeutralExportCsv, categorizeTransaction } from '../src/lib/transactionCodingDomain.js'
import {
  alignTransactionRuleValues,
  buildTransactionCodingWorkbook,
  deleteTransactionRuleFromWorkbook,
  ensureTransactionCodingWorkspace,
  RULE_HEADERS,
  saveTransactionRuleToWorkbook,
} from '../src/lib/transactionCodingSharePoint.js'
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

test('user-initiated workbook access uses the delegated Graph token', async (t) => {
  const requests = []
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    requests.push({ url: String(url), authorization: new Headers(options.headers).get('Authorization') })
    if (String(url).includes('items/crm-workbook?')) {
      return Response.json({ id: 'crm-workbook', parentReference: { id: 'root-folder' } })
    }
    if (String(url).endsWith('root-folder:/Transaction%20Coding')) {
      return Response.json({ id: 'coding-folder', webUrl: 'https://example.test/coding' })
    }
    if (String(url).endsWith('coding-folder:/Exports')) {
      return Response.json({ id: 'exports-folder', webUrl: 'https://example.test/exports' })
    }
    if (String(url).endsWith('coding-folder:/Transaction%20Coding.xlsx')) {
      return Response.json({ id: 'coding-workbook', webUrl: 'https://example.test/workbook' })
    }
    return Response.json({ error: { message: 'Unexpected request' } }, { status: 500 })
  })
  const workspace = await ensureTransactionCodingWorkspace({ WORKBOOK_ID: 'crm-workbook', DRIVE_ID: 'drive-1' }, 'delegated-token')
  assert.equal(workspace.workbookItemId, 'coding-workbook')
  assert.ok(requests.length >= 4)
  assert.ok(requests.every((request) => request.authorization === 'Bearer delegated-token'))
})

test('deleting a workbook rule targets its stable rule ID', async (t) => {
  const deleted = []
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    const path = String(url)
    if (path.endsWith('/tables/TransactionMappingsTable')) return Response.json({ id: 'rules-table', name: 'TransactionMappingsTable' })
    if (path.endsWith('/columns')) return Response.json({ value: RULE_HEADERS.map((name) => ({ name })) })
    if (path.includes('/rows?$top=1000')) {
      return Response.json({ value: [{ index: 3, values: [['rule-1', 'Yes', 100, 'contains', 'SCRIBD']] }] })
    }
    if (options.method === 'DELETE') {
      deleted.push(path)
      return new Response(null, { status: 204 })
    }
    return Response.json({ error: { message: 'Unexpected request' } }, { status: 500 })
  })
  const removed = await deleteTransactionRuleFromWorkbook({ driveId: 'drive-1', workbookItemId: 'workbook-1', token: 'delegated-token' }, 'rule-1')
  assert.equal(removed, true)
  assert.match(deleted[0], /rows\/itemAt\(index=3\)$/)
})

test('a missing categorization table is repaired on the existing Rules worksheet', async (t) => {
  const requests = []
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    const path = String(url)
    requests.push({ path, method: options.method || 'GET' })
    if (path.endsWith('/tables/TransactionMappingsTable')) {
      return Response.json({ error: { code: 'ItemNotFound', message: "The requested resource doesn't exist." } }, { status: 404 })
    }
    if (path.endsWith('/worksheets')) return Response.json({ value: [{ id: 'rules-sheet', name: 'Rules' }] })
    if (path.endsWith('/worksheets/rules-sheet/tables')) return Response.json({ value: [] })
    if (path.endsWith('/worksheets/rules-sheet/usedRange(valuesOnly=true)')) {
      return Response.json({ values: [RULE_HEADERS, Array(RULE_HEADERS.length).fill('')] })
    }
    if (path.endsWith('/worksheets/rules-sheet/tables/add')) return Response.json({ id: 'repaired-table', name: 'Table1' })
    if (path.endsWith('/tables/repaired-table') && options.method === 'PATCH') return Response.json({ id: 'repaired-table', name: 'TransactionMappingsTable' })
    if (path.endsWith('/tables/repaired-table/columns')) return Response.json({ value: RULE_HEADERS.map((name) => ({ name })) })
    if (path.includes('/tables/repaired-table/rows?$top=1000')) return Response.json({ value: [] })
    if (path.endsWith('/tables/repaired-table/rows/add')) return Response.json({ index: 1 })
    return Response.json({ error: { message: `Unexpected request: ${path}` } }, { status: 500 })
  })
  await saveTransactionRuleToWorkbook(
    { driveId: 'drive-1', workbookItemId: 'workbook-1', token: 'delegated-token' },
    ['rule-1', 'Yes', 100, 'contains', 'SCRIBD', 'Scribd'],
  )
  assert.ok(requests.some((request) => request.path.endsWith('/worksheets/rules-sheet/tables/add')))
  assert.ok(requests.some((request) => request.path.endsWith('/tables/repaired-table/rows/add')))
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
