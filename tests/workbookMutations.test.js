import assert from 'node:assert/strict'
import test from 'node:test'
import {
  appendWithReconciliation,
  createOnce,
  createStableId,
  retryIdempotent,
  workbookRetryDelay,
} from '../src/services/workbookMutations.js'
import { readFileSync } from 'node:fs'

test('record navigation and UI selection do not depend on workbook row positions', () => {
  const files = [
    'pages/Opportunities.jsx', 'pages/SearchModal.jsx', 'pages/Dashboard.jsx',
    'pages/OpportunityDetail.jsx', 'pages/SAMOpportunityDetail.jsx',
    'pages/EbuyOpportunityDetail.jsx', 'pages/Contacts.jsx', 'pages/Tasks.jsx',
    'pages/OpportunityDossier.jsx', 'components/Opportunity/EbuyDiscovery.jsx',
    'components/Opportunity/FollowUpEmailComposer.jsx', 'hooks/useSAMChangeMonitor.js',
  ]
  for (const file of files) {
    const source = readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8')
    assert.doesNotMatch(source, /_rowIndex|\?row=|searchParams\.get\('row'\)/, file)
  }
  const opportunities = readFileSync(new URL('../src/pages/Opportunities.jsx', import.meta.url), 'utf8')
  assert.match(opportunities, /samChangesById\[recordIdentity\('NewOpportunitiesTable', opportunity\)\]/)
  assert.match(opportunities, /reconcilingSAMStatusesRef\.current\.set\(recordId, expectedStatus\)/)
})
import { recordIdentity, externallyChangedPatchedFields, mutationTarget } from '../src/utils/recordConflict.js'
import { mutateWorkbookRecord } from '../workers/tag-pipeline-api/src/lib/graph.js'

const graphSource = readFileSync(new URL('../src/services/graphService.js', import.meta.url), 'utf8')

test('Partner IDs migrate once, survive corrections and resume without rewriting completed IDs', async () => {
  const rows = [{ 'UEI Number': 'ABC123456789', 'Partner Name': 'One', _rowIndex: 0 }, { 'Partner Name': 'No UEI yet', _rowIndex: 1 }]
  const writes = []
  const deps = { recordIdentity, normalizeTableHeader: key => key.toLowerCase().replace(/[^a-z0-9]/g, ''),
    ensureTableColumns: async () => ({ headers: ['Partner ID', 'UEI Number', 'Partner Name', 'Legacy Partner References'] }),
    getSheetRows: async () => rows.map(row => ({ ...row })), invalidate: () => {},
    updateRow: async (table, target, patch) => { const row = mutationTarget(table, recordIdentity(table, target), rows); writes.push(patch); Object.assign(rows.find(item => item._rowIndex === row._rowIndex), patch) },
  }
  const source = graphSource.slice(graphSource.indexOf('let partnerIdentityMigration ='), graphSource.indexOf('export async function getPartners()'))
  const migrate = new Function(...Object.keys(deps), `${source}; return ensurePartnerIdentities`)(...Object.values(deps))
  await Promise.all([migrate(), migrate()])
  assert.equal(writes.length, 2)
  assert.match(rows[0]['Partner ID'], /^P-[a-f0-9]{32}$/)
  const id = rows[0]['Partner ID']
  rows[0]['UEI Number'] = 'DEF123456789'
  await migrate()
  assert.equal(writes.length, 2)
  assert.equal(rows[0]['Partner ID'], id)
  assert.equal(rows[0]['Legacy Partner References'], 'ABC123456789')
})

test('background jobs relocate by ID and preserve unrelated live fields', async t => {
  const headers = ['ContactID', 'Name', 'Notes']
  const writes = []
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    const path = String(url)
    if (options.method === 'PATCH') { writes.push({ path, values: JSON.parse(options.body).values }); return Response.json({}) }
    if (path.endsWith('/columns')) return Response.json({ value: headers.map(name => ({ name })) })
    if (path.includes('/rows?')) return Response.json({ value: [{ index: 8, values: [['C1', 'Old name', 'New note from Excel']] }] })
    if (path.endsWith('/rows/itemAt(index=0)')) return Response.json({ values: [['OTHER', 'Other person', 'Do not touch']] })
    throw new Error(`Unexpected call ${path}`)
  })
  await mutateWorkbookRecord({ WORKBOOK_ID: 'test' }, 'drive', 'token', 'ContactsTable', { _rowIndex: 0, ContactID: 'C1', Name: 'Old name' }, { Name: 'New name' }, { headers })
  assert.equal(writes.length, 1)
  assert.match(writes[0].path, /index=8/)
  assert.deepEqual(writes[0].values, [['C1', 'New name', 'New note from Excel']])
})

test('background deletion cannot delete a restored or duplicate record', async t => {
  const headers = ['Notice ID', 'Status']
  let duplicates = false
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    assert.notEqual(options.method, 'DELETE')
    if (String(url).endsWith('/columns')) return Response.json({ value: headers.map(name => ({ name })) })
    if (String(url).includes('/rows?')) return Response.json({ value: [{ index: 1, values: [['N1', 'new']] }, { index: 2, values: [['N1', 'dismissed']] }] })
    return Response.json({ values: [[duplicates ? 'OTHER' : 'N1', 'new']] })
  })
  const run = () => mutateWorkbookRecord({ WORKBOOK_ID: 'test' }, 'drive', 'token', 'NewOpportunitiesTable', { _rowIndex: 0, 'Notice ID': 'N1', Status: 'dismissed' }, {}, { headers, remove: true, guard: row => row.Status === 'dismissed' })
  await assert.rejects(run(), /Record changed/)
  duplicates = true
  await assert.rejects(run(), /Duplicate/)
})
function rowHarness({ moved = false, missingIndex = false, conflict = false, unchanged = false } = {}) {
  const original = { ContactID: 'C1', Name: 'Original', Notes: 'Old', _rowIndex: 0 }
  const live = { ContactID: 'C1', Name: conflict ? 'Someone else' : unchanged ? 'Updated' : 'Original', Notes: 'Keep newest notes', _rowIndex: moved || missingIndex ? 4 : 0 }
  const headers = ['ContactID', 'Name', 'Notes']
  const cache = new Map([['ContactsTable', [original]]]); const calls = []
  const deps = {
    cache, recordIdentity, externallyChangedPatchedFields, DATE_COLUMNS: new Set(),
    excelDateToISO: value => value, isoToExcelSerial: value => value,
    invalidate: table => cache.delete(table),
    getTableHeaders: async () => headers,
    getSheetRows: async () => { calls.push('table'); return [live] },
    graphFetch: async (path, options = {}) => {
      calls.push(options.method || 'GET')
      if (options.method === 'PATCH') { assert.equal(path, `/tables/ContactsTable/rows/itemAt(index=${live._rowIndex})`); assert.deepEqual(JSON.parse(options.body).values[0], ['C1', 'Updated', 'Keep newest notes']); return null }
      if (missingIndex) throw Object.assign(new Error('Not found'), { status: 404 })
      const row = moved ? { ContactID: 'OTHER', Name: 'Other', Notes: '' } : live
      return { values: [headers.map(header => row[header])] }
    },
  }
  const fn = graphSource.slice(graphSource.indexOf('async function updateRowUnlocked('), graphSource.indexOf('export async function updateRow('))
  const update = new Function(...Object.keys(deps), `${fn}; return updateRowUnlocked`)(...Object.values(deps))
  return { original, headers, cache, calls, run: () => update('ContactsTable', 0, { Name: 'Updated' }, headers, { original }) }
}

test('ordinary workbook edit uses one row read and one write, preserving unrelated live fields', async () => {
  const h = rowHarness(); await h.run()
  assert.deepEqual(h.calls, ['GET', 'PATCH'])
  assert.equal(h.cache.get('ContactsTable')[0].Notes, 'Keep newest notes')
})

test('moved or removed row indexes trigger a stable-ID lookup before writing', async () => {
  for (const options of [{ moved: true }, { missingIndex: true }]) {
    const h = rowHarness(options); await h.run()
    assert.deepEqual(h.calls, ['GET', 'table', 'PATCH'])
  }
})

test('no-op edit skips PATCH but refreshes the local row; conflicting edit never writes', async () => {
  const unchanged = rowHarness({ unchanged: true }); await unchanged.run()
  assert.deepEqual(unchanged.calls, ['GET'])
  assert.equal(unchanged.cache.get('ContactsTable')[0].Name, 'Updated')
  const conflict = rowHarness({ conflict: true })
  await assert.rejects(conflict.run(), /changed in Excel/)
  assert.deepEqual(conflict.calls, ['GET'])
})

test('missing Partner ID columns use the Graph add action and are not created twice', async () => {
  const headers = ['Partner Name', 'UEI Number']
  const writes = []
  const deps = {
    headerCache: new Map(), pendingHeaderReads: new Map(), pendingSchemas: new Map(), schemaCheckedAt: new Map(), cacheEpoch: 0,
    graphFetch: async (path, options = {}) => {
      if (options.method === 'POST') {
        assert.equal(path, '/tables/PartnersTable/columns/add')
        const { name } = JSON.parse(options.body)
        assert.ok(!headers.includes(name))
        headers.push(name); writes.push(name)
        return { name }
      }
      assert.equal(path, '/tables/PartnersTable/columns')
      return { value: headers.map(name => ({ name })) }
    }, invalidate: () => {},
  }
  const section = graphSource.slice(graphSource.indexOf('async function getTableHeaders('), graphSource.indexOf('// ── Token helper')).replace('export async function', 'async function')
  const ensure = new Function(...Object.keys(deps), `${section}; return ensureTableColumns`)(...Object.values(deps))
  await Promise.all([ensure('PartnersTable', ['Partner ID', 'Legacy Partner References']), ensure('PartnersTable', ['Partner ID', 'Legacy Partner References'])])
  assert.deepEqual(writes, ['Partner ID', 'Legacy Partner References'])
})

test('Partner ID setup failures expose the failed endpoint instead of a generic blank page', async () => {
  const deps = {
    ensurePartnerIdentities: async () => { throw Object.assign(new Error('Not found'), { status: 404, requestPath: '/tables/PartnersTable/columns/add', requestMethod: 'POST' }) },
  }
  const section = graphSource.slice(graphSource.indexOf('export async function getPartners()'), graphSource.indexOf('const PARTNER_VEHICLE_TABLE')).replace('export async function', 'async function')
  const getPartners = new Function(...Object.keys(deps), `${section}; return getPartners`)(...Object.values(deps))
  await assert.rejects(getPartners(), /Partner ID setup.*POST \/tables\/PartnersTable\/columns\/add, HTTP 404/)
})

test('concurrent and repeated schema checks share one header request', async () => {
  let reads = 0
  const deps = {
    headerCache: new Map(), pendingHeaderReads: new Map(), pendingSchemas: new Map(), schemaCheckedAt: new Map(), cacheEpoch: 0,
    graphFetch: async () => { reads++; return { value: [{ name: 'ID' }] } }, invalidate: () => {},
  }
  const section = graphSource.slice(graphSource.indexOf('async function getTableHeaders('), graphSource.indexOf('// ── Token helper')).replace('export async function', 'async function')
  const ensure = new Function(...Object.keys(deps), `${section}; return ensureTableColumns`)(...Object.values(deps))
  await Promise.all([ensure('Test', ['ID']), ensure('Test', ['ID'])])
  await ensure('Test', ['ID'])
  assert.equal(reads, 1)
})

test('late workbook reads cannot replace a newer invalidated cache generation', async () => {
  let release; let reads = 0
  const old = new Promise(resolve => { release = resolve })
  const cache = new Map(); const rowVersions = new Map()
  const deps = {
    cache, rowVersions, cacheEpoch: 0, pendingSheetReads: new Map(), DATE_COLUMNS: new Set(), excelDateToISO: value => value,
    getTableHeaders: async () => ['Name'],
    graphFetch: async () => ++reads === 1 ? old : { value: [{ index: 0, values: [['New']] }] },
  }
  const section = graphSource.slice(graphSource.indexOf('export async function getSheetRows('), graphSource.indexOf('export async function appendRow(')).replace('export async function', 'async function')
  const getRows = new Function(...Object.keys(deps), `${section}; return getSheetRows`)(...Object.values(deps))
  const first = getRows('Test')
  rowVersions.set('Test', 1)
  await getRows('Test')
  release({ value: [{ index: 0, values: [['Old']] }] })
  await first
  assert.equal(cache.get('Test')[0].Name, 'New')
})

test('validation, permission and already exhausted retries fail once', async () => {
  for (const error of [new Error('Edit conflict'), Object.assign(new Error('Denied'), { status: 403 }), Object.assign(new Error('Unavailable'), { status: 503, retryExhausted: true })]) {
    let calls = 0
    await assert.rejects(retryIdempotent(async () => { calls++; throw error }), error)
    assert.equal(calls, 1)
  }
})

test('transient writes retry with the supplied delay and honor Retry-After formats', async () => {
  let calls = 0
  assert.equal(await retryIdempotent(async () => { if (++calls === 1) throw Object.assign(new Error('Busy'), { status: 429, retryAfterMs: 0 }); return 'saved' }), 'saved')
  assert.equal(calls, 2)
  assert.equal(workbookRetryDelay('12'), 12000)
  assert.equal(workbookRetryDelay(null, 350), 350)
  assert.equal(workbookRetryDelay('Wed, 16 Sep 2026 12:00:10 GMT', 400, Date.parse('2026-09-16T12:00:00Z')), 10000)
})

test('successful save publishing does not wait for consumer refresh requests', async () => {
  const source = readFileSync(new URL('../src/services/dataCache.js', import.meta.url), 'utf8')
  const section = source.slice(source.indexOf('export async function publishCacheUpdate('), source.indexOf('export function verifyCacheInBackground(')).replace('export async function', 'async function')
  let notified = false
  let release; const consumer = new Promise(resolve => { release = resolve })
  const deps = { loaders: { TasksTable: true }, publishDataChanged: () => {}, lastTableRefreshAt: new Map(), dirtyTables: new Set(), notify: () => { notified = true; return consumer } }
  const publish = new Function(...Object.keys(deps), `${section}; return publishCacheUpdate`)(...Object.values(deps))
  try {
    const result = await Promise.race([publish(['TasksTable']), new Promise(resolve => setTimeout(() => resolve('blocked'), 50))])
    assert.deepEqual(result, ['TasksTable'])
    assert.equal(notified, true)
  } finally { release() }
})

test('creates stable prefixed identifiers before a workbook append', () => {
  const id = createStableId('T')
  assert.match(id, /^T-[a-z0-9-]+$/i)
})

test('recovers an append that succeeded before Graph returned an error', async () => {
  const rows = []
  let appends = 0
  const result = await appendWithReconciliation({
    idColumn: 'TaskID',
    idValue: 'T-fixed',
    record: { TaskID: 'T-fixed', Title: 'Review' },
    append: async () => {
      appends++
      rows.push({ TaskID: 'T-fixed', Title: 'Review', _rowIndex: 4 })
      throw new Error('Gateway timeout')
    },
    readRows: async () => rows,
  })

  assert.equal(appends, 1)
  assert.equal(result.TaskID, 'T-fixed')
  assert.equal(result._recovered, true)
})

test('retries the same identity only after confirming it is absent', async () => {
  let appends = 0
  const result = await appendWithReconciliation({
    idColumn: 'NoteID',
    idValue: 'N-fixed',
    record: { NoteID: 'N-fixed', NoteText: 'Update' },
    append: async () => {
      appends++
      if (appends === 1) throw new Error('Temporary failure')
      return { index: 8 }
    },
    readRows: async () => [],
  })

  assert.equal(appends, 2)
  assert.equal(result.NoteID, 'N-fixed')
  assert.equal(result._rowIndex, 8)
})

test('does not risk a duplicate when reconciliation also fails', async () => {
  let appends = 0
  await assert.rejects(
    appendWithReconciliation({
      idColumn: 'ContactID',
      idValue: 'C-fixed',
      record: { ContactID: 'C-fixed' },
      append: async () => {
        appends++
        throw new Error('Ambiguous Graph response')
      },
      readRows: async () => { throw new Error('Workbook unavailable') },
    }),
    /was not retried/,
  )
  assert.equal(appends, 1)
})

test('coalesces repeated clicks while the same create is in flight', async () => {
  let calls = 0
  const operation = () => createOnce('task:one', async () => {
    calls++
    await Promise.resolve()
    return { ok: true }
  })
  const [first, second] = await Promise.all([operation(), operation()])
  assert.equal(calls, 1)
  assert.deepEqual(first, second)
})
