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
import { recordIdentity, externallyChangedPatchedFields } from '../src/utils/recordConflict.js'

const graphSource = readFileSync(new URL('../src/services/graphService.js', import.meta.url), 'utf8')
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
  const fn = graphSource.slice(graphSource.indexOf('async function updateRowUnlocked('), graphSource.indexOf('export function updateRow('))
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
