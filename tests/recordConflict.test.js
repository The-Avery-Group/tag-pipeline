import assert from 'node:assert/strict'
import test from 'node:test'
import { externallyChangedPatchedFields, recordIdentity } from '../src/utils/recordConflict.js'

test('uses the stable identifier for each workbook record type', () => {
  assert.equal(recordIdentity('PipelineTable', { 'Contract Number / Notice ID': '  47QSHA-25-D-0001 ' }), '47QSHA-25-D-0001')
  assert.equal(recordIdentity('ContactsTable', { ContactID: 'C-100' }), 'C-100')
  assert.equal(recordIdentity('PartnersTable', { 'UEI Number': 'ABC123' }), 'ABC123')
})

test('blocks only fields that changed externally and are also being saved', () => {
  const cached = { Title: 'Original', Agency: 'Agency A', Priority: 'Warm' }
  const current = { Title: 'Original', Agency: 'Agency B', Priority: 'Warm' }

  assert.deepEqual(externallyChangedPatchedFields(cached, current, { Title: 'Updated' }), [])
  assert.deepEqual(externallyChangedPatchedFields(cached, current, { Agency: 'Agency C', Priority: 'Hot' }), ['Agency'])
  assert.deepEqual(externallyChangedPatchedFields(cached, current, { Agency: 'Agency B' }), [])
})
