import assert from 'node:assert/strict'
import test from 'node:test'
import {
  appendWithReconciliation,
  createOnce,
  createStableId,
} from '../src/services/workbookMutations.js'

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
