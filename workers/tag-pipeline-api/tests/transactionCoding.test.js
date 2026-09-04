import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildCostpointApVoucherCsv,
  categorizeTransaction,
  COSTPOINT_DETAIL_FIELD_COUNT,
  COSTPOINT_HEADER_FIELD_COUNT,
  invoiceReferenceSequenceState,
  resolveInvoiceReferencePattern,
} from '../src/lib/transactionCodingDomain.js'
import {
  alignTransactionRuleValues,
  deleteTransactionRuleFromWorkbook,
  ensureTransactionCodingWorkspace,
  RULE_HEADERS,
  saveTransactionRuleToWorkbook,
} from '../src/lib/transactionCodingSharePoint.js'
import { attemptTransactionRuleSync, transactionCodingAccess, TRANSACTION_CODING_HTTP_METHODS } from '../src/handlers/transactionCoding.js'
import { TRANSACTION_CODING_RETENTION_DAYS, transactionCodingStorageReady, transactionsForExport } from '../src/lib/transactionCodingRepository.js'

test('categorizes a statement row with the highest-priority matching rule', () => {
  const row = categorizeTransaction({ rawDescription: 'SCRIBD *662092010', amountCents: 1299 }, [
    { id: 'broad', active: true, priority: 10, matchPattern: 'SCRIBD', vendor: 'Wrong' },
    { id: 'specific', active: true, priority: 100, matchPattern: 'SCRIBD', vendor: 'Scribd', vendorId: 'V-1', project: 'GENAD.001', account: '840-010', organization: '1.01.90.01' },
  ])
  assert.equal(row.ruleId, 'specific')
  assert.equal(row.status, 'ready')
})

test('whole-word rules match standalone phrases without matching embedded text', () => {
  const rule = { id: 'ace', active: true, matchType: 'whole_word', matchPattern: 'ACE', vendor: 'Ace Hardware' }
  assert.equal(categorizeTransaction({ rawDescription: 'ACE HARDWARE 1234' }, [rule]).ruleId, 'ace')
  assert.equal(categorizeTransaction({ rawDescription: 'PALACE HOTEL' }, [rule]).ruleId, null)
  assert.equal(categorizeTransaction({ rawDescription: 'PAYPAL*ACEHARDWARE' }, [{ ...rule, matchType: 'contains' }]).ruleId, 'ace')
})

test('transaction coding routes allow rule deletion', () => {
  assert.equal(TRANSACTION_CODING_HTTP_METHODS.includes('DELETE'), true)
})

test('transaction coding retains in-app statement data for ten days', () => {
  assert.equal(TRANSACTION_CODING_RETENTION_DAYS, 10)
})

test('transaction coding access is fail-closed and accepts approved Entra IDs or user principal names', () => {
  assert.deepEqual(transactionCodingAccess({ userId: 'user-1', email: 'person@example.com' }, {}), { configured: false, allowed: false })
  const env = { TRANSACTION_CODING_ALLOWED_USERS: 'approved-id, finance@example.com' }
  assert.equal(transactionCodingAccess({ userId: 'APPROVED-ID', email: 'other@example.com' }, env).allowed, true)
  assert.equal(transactionCodingAccess({ userId: 'other-id', email: 'Finance@Example.com' }, env).allowed, true)
  assert.equal(transactionCodingAccess({ userId: 'other-id', email: 'other@example.com' }, env).allowed, false)
})

const exportRow = {
  id: 'txn-1', sourceRow: 3, transactionDate: '2026-08-01', rawDescription: 'SCRIBD, MONTHLY\nSUBSCRIPTION',
  city: 'Houston', amountCents: 1299, vendor: 'Scribd', vendorId: 'V-1', project: 'P1', account: 'A1', organization: 'O1',
}

test('Costpoint export emits a positional H and D record without a heading row', () => {
  const result = buildCostpointApVoucherCsv([exportRow], {
    invoiceReferences: { 'txn-1': 'SCRIBD-0826' },
    inputVoucherNumbers: { 'txn-1': '123456789' },
  })
  const lines = result.csv.trimEnd().split('\r\n').map((line) => line.split(','))
  assert.equal(lines.length, 2)
  assert.equal(lines[0].length, COSTPOINT_HEADER_FIELD_COUNT)
  assert.equal(lines[1].length, COSTPOINT_DETAIL_FIELD_COUNT)
  assert.equal(lines[0][0], 'H')
  assert.equal(lines[1][0], 'D')
  assert.equal(lines[0][1], '123456789')
  assert.equal(lines[1][1], '123456789')
  assert.equal(lines[0][5], 'V-1')
  assert.equal(lines[0][7], 'SCRIBD-0826')
  assert.equal(lines[0][8], '2026-08-01')
  assert.equal(lines[0][9], '12.99')
  assert.equal(lines[0][14], 'N')
  assert.equal(lines[1][4], 'A1')
  assert.equal(lines[1][5], 'O1')
  assert.equal(lines[1][6], 'P1')
  assert.equal(lines[1][9], '12.99')
  assert.equal(lines[1][10], 'N')
  assert.equal(lines[1][18], 'SCRIBD MONTHLY SUBSCRIPTION')
  assert.doesNotMatch(result.csv, /Transaction ID|Coding Status|Merchant/)
})

test('Costpoint export matches the official Advanced AOPUTLAP CSV record lengths', () => {
  const result = buildCostpointApVoucherCsv([exportRow], {
    invoiceReferences: { 'txn-1': 'SCRIBD-0826' },
    inputVoucherNumbers: { 'txn-1': '123456789' },
  })
  const [header, detail] = result.csv.trimEnd().split('\r\n').map((line) => line.split(','))
  assert.equal(COSTPOINT_HEADER_FIELD_COUNT, 37)
  assert.equal(COSTPOINT_DETAIL_FIELD_COUNT, 23)
  assert.equal(header.length, 37)
  assert.equal(detail.length, 23)
  assert.equal(header.at(-1), '')
  assert.equal(detail.at(-1), '')
})

test('custom invoice reference patterns use month and padded sequence only', () => {
  assert.equal(resolveInvoiceReferencePattern('INV-{date}-{sequence}', exportRow, 3), 'INV-2026-08-003')
  assert.equal(resolveInvoiceReferencePattern('INV{date}{sequence}', exportRow, 1000), 'INV2026-081000')
  const result = buildCostpointApVoucherCsv([exportRow], {
    invoiceReferenceMode: 'custom',
    invoiceReferencePattern: 'INV-{date}-{sequence}',
  })
  assert.equal(result.invoiceReferences['txn-1'], 'INV-2026-08-001')
  assert.throws(() => resolveInvoiceReferencePattern('{customCode}-{sequence}', exportRow), /not available/)
})

test('monthly invoice sequence state is recovered from retained Costpoint exports', () => {
  const csv = [
    'H,1,,,,,,INV-2026-08-001,2026-08-01',
    'D,1',
    'H,2,,,,,,INV2026-081000,2026-08-02',
    'H,3,,,,,,INV-2026-09-007,2026-09-01',
  ].join('\r\n')
  assert.deepEqual(invoiceReferenceSequenceState([csv]).nextByMonth, { '2026-08': 1001, '2026-09': 8 })
})

test('Costpoint export rejects invalid or duplicated user-defined identifiers', () => {
  assert.throws(() => buildCostpointApVoucherCsv([exportRow], { invoiceReferences: { 'txn-1': 'REFERENCE-IS-TOO-LONG' } }), /15-character limit/)
  assert.throws(() => buildCostpointApVoucherCsv([{ ...exportRow, id: 'one' }, { ...exportRow, id: 'two' }], {
    invoiceReferences: { one: 'DUPLICATE', two: 'DUPLICATE' },
  }), /duplicated/)
  assert.throws(() => buildCostpointApVoucherCsv([exportRow], { inputVoucherNumbers: { 'txn-1': 'ABC' } }), /1 to 9 digits/)
})

test('Costpoint export requires complete coding and a valid transaction date', () => {
  assert.throws(() => buildCostpointApVoucherCsv([{ ...exportRow, project: '' }]), /Project is required/)
  assert.throws(() => buildCostpointApVoucherCsv([{ ...exportRow, transactionDate: '' }]), /valid transaction date/)
})

test('an explicit export selection can include needs-review rows but rejects stale IDs', async () => {
  const rows = [
    { id: 'ready-1', status: 'ready', exported_at: null },
    { id: 'review-1', status: 'review', exported_at: null },
  ]
  const db = {
    prepare() {
      return { bind: () => ({ all: async () => ({ results: rows }) }) }
    },
  }
  assert.deepEqual((await transactionsForExport(db, 'batch-1')).map((row) => row.id), ['ready-1'])
  assert.deepEqual((await transactionsForExport(db, 'batch-1', ['review-1'])).map((row) => row.id), ['review-1'])
  await assert.rejects(transactionsForExport(db, 'batch-1', ['missing']), /changed or were already exported/i)
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

test('transaction coding SharePoint access never falls back to the application identity', async () => {
  await assert.rejects(
    ensureTransactionCodingWorkspace({ WORKBOOK_ID: 'crm-workbook', DRIVE_ID: 'drive-1' }),
    (error) => error.code === 'delegated_token_required',
  )
})

test('a missing manual workbook returns setup guidance without uploading a generated file', async (t) => {
  const requests = []
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    const path = String(url)
    requests.push({ path, method: options.method || 'GET' })
    if (path.includes('items/crm-workbook?')) return Response.json({ id: 'crm-workbook', parentReference: { id: 'root-folder' } })
    if (path.endsWith('root-folder:/Transaction%20Coding')) return Response.json({ id: 'coding-folder' })
    if (path.endsWith('coding-folder:/Exports')) return Response.json({ id: 'exports-folder' })
    if (path.endsWith('coding-folder:/Transaction%20Coding.xlsx')) return Response.json({}, { status: 404 })
    return Response.json({ error: { message: `Unexpected request: ${path}` } }, { status: 500 })
  })
  await assert.rejects(
    ensureTransactionCodingWorkspace({ WORKBOOK_ID: 'crm-workbook', DRIVE_ID: 'drive-1' }, 'delegated-token'),
    /Create the workbook and its required Excel tables/,
  )
  assert.equal(requests.some((request) => request.method === 'PUT'), false)
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

test('a missing categorization table returns manual setup guidance without changing the workbook', async (t) => {
  const requests = []
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    const path = String(url)
    requests.push({ path, method: options.method || 'GET' })
    if (path.endsWith('/tables/TransactionMappingsTable')) {
      return Response.json({ error: { code: 'ItemNotFound', message: "The requested resource doesn't exist." } }, { status: 404 })
    }
    return Response.json({ error: { message: `Unexpected request: ${path}` } }, { status: 500 })
  })
  await assert.rejects(
    saveTransactionRuleToWorkbook(
      { driveId: 'drive-1', workbookItemId: 'workbook-1', token: 'delegated-token' },
      ['rule-1', 'Yes', 100, 'contains', 'SCRIBD', 'Scribd'],
    ),
    /Create the Rules table with the required columns/,
  )
  assert.equal(requests.some((request) => ['POST', 'PATCH', 'DELETE'].includes(request.method)), false)
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
