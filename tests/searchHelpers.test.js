import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildSearchIndex,
  filterSearchIndex,
  rankSearchIndex,
} from '../src/utils/searchHelpers.js'

test('indexes all user-facing fields once and filters without internal metadata', () => {
  const rows = [
    { Name: 'Jane Doe', Agency: 'NASA', Notes: 'Met at event', _rowIndex: 1 },
    { Name: 'John Smith', Agency: 'Army', Notes: '', _rowIndex: 2 },
  ]
  const index = buildSearchIndex(rows)
  assert.deepEqual(filterSearchIndex(index, 'event'), [rows[0]])
  assert.deepEqual(filterSearchIndex(index, 'rowindex'), [])
})

test('ranks exact field matches ahead of partial matches', () => {
  const rows = [
    { Name: 'NASA program manager' },
    { Name: 'NASA' },
  ]
  assert.deepEqual(rankSearchIndex(buildSearchIndex(rows), 'nasa'), [rows[1], rows[0]])
})
