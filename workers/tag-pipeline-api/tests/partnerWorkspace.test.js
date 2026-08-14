import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizePartnerFolderName } from '../src/lib/partnerWorkspaceSharePoint.js'

test('partner folder matching tolerates punctuation and legal suffix differences', () => {
  assert.equal(normalizePartnerFolderName('Example Technology Group, LLC'), 'example technology group')
  assert.equal(normalizePartnerFolderName('Example-Technology Group LLC'), 'example technology group')
  assert.equal(normalizePartnerFolderName('Ávery & Partners, Inc.'), 'avery and partners')
})

test('partner folder matching does not erase meaningful company words', () => {
  assert.notEqual(normalizePartnerFolderName('Avery Group'), normalizePartnerFolderName('Avery'))
  assert.notEqual(normalizePartnerFolderName('Avery Technologies LLC'), normalizePartnerFolderName('Avery Consulting LLC'))
})
