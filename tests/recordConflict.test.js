import assert from 'node:assert/strict'
import test from 'node:test'
import { externallyChangedPatchedFields, recordIdentity, mutationTarget, sameRecord } from '../src/utils/recordConflict.js'

test('uses the stable identifier for each workbook record type', () => {
  assert.equal(recordIdentity('PipelineTable', { 'Contract Number / Notice ID': '  47QSHA-25-D-0001 ' }), '47QSHA-25-D-0001')
  assert.equal(recordIdentity('ContactsTable', { ContactID: 'C-100' }), 'C-100')
  assert.equal(recordIdentity('PartnersTable', { 'UEI Number': 'ABC123' }), 'ABC123')
  assert.equal(recordIdentity('OpportunityRelationshipsTable', { 'Relationship ID': 'OR-100' }), 'OR-100')
})

test('record targeting rejects positional callers and ambiguous IDs', () => {
  const rows = [{ ContactID: 'A', _rowIndex: 1 }, { ContactID: 'B', _rowIndex: 0 }]
  assert.equal(mutationTarget('ContactsTable', 'A', rows)._rowIndex, 1)
  assert.throws(() => mutationTarget('ContactsTable', 0, rows), /stable record ID/)
  assert.throws(() => mutationTarget('ContactsTable', { _rowIndex: 0 }, rows), /stable record ID/)
  assert.throws(() => mutationTarget('ContactsTable', 'A', [...rows, rows[0]]), /Duplicate/)
  assert.throws(() => mutationTarget('ContactsTable', 'missing', rows), /not found/)
  assert.equal(sameRecord('ContactsTable', rows[0], { ContactID: 'A', _rowIndex: 0 }), true)
  assert.equal(sameRecord('ContactsTable', rows[1], { ContactID: 'A', _rowIndex: 0 }), false)
})

test('partner identity survives UEI correction and supports legacy header variants', () => {
  const before = { 'Partner ID': 'P-one', 'UEI Number': 'WRONG1234567', _rowIndex: 2 }
  const after = { ...before, 'UEI Number': 'RIGHT1234567', _rowIndex: 9 }
  assert.equal(recordIdentity('PartnersTable', before), 'P-one')
  assert.equal(sameRecord('PartnersTable', before, after), true)
  assert.equal(recordIdentity('PartnersTable', { 'partner id ': 'P-two', 'UEI Number': 'OTHER' }), 'P-two')
  assert.equal(recordIdentity('RFIFollowUpDecisionsTable', { 'Opportunity ID': 'O1', 'Follow-up Notice ID': 'N1' }), JSON.stringify(['O1', 'N1', '']))
})

test('blocks only fields that changed externally and are also being saved', () => {
  const cached = { Title: 'Original', Agency: 'Agency A', Priority: 'Warm' }
  const current = { Title: 'Original', Agency: 'Agency B', Priority: 'Warm' }

  assert.deepEqual(externallyChangedPatchedFields(cached, current, { Title: 'Updated' }), [])
  assert.deepEqual(externallyChangedPatchedFields(cached, current, { Agency: 'Agency C', Priority: 'Hot' }), ['Agency'])
  assert.deepEqual(externallyChangedPatchedFields(cached, current, { Agency: 'Agency B' }), [])
})
