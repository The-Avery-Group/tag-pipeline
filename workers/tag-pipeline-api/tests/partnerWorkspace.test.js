import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizePartnerFolderName, partnerWorkbookValue, partnerSharedFolderLink } from '../src/lib/partnerWorkspaceSharePoint.js'

test('subsidiaries reuse only an explicitly grouped shared folder', () => {
  const partner = { 'Partner Group': 'Example' }
  const siblings = [{ 'Partner Group': 'example', 'Link to Partner Folder': 'https://example.sharepoint.com/shared/' }]
  assert.equal(partnerSharedFolderLink(partner, siblings), 'https://example.sharepoint.com/shared')
  assert.equal(partnerSharedFolderLink({}, siblings), '')
  assert.equal(partnerSharedFolderLink({ ...partner, 'Link to Partner Folder': 'own' }, siblings), 'own')
})

test('conflicting sibling folders are not silently chosen', () => {
  const siblings = ['one', 'two'].map(link => ({ 'Partner Group': 'Example', 'Link to Partner Folder': link }))
  assert.throws(() => partnerSharedFolderLink({ 'Partner Group': 'Example' }, siblings), { status: 409 })
})

test('partner folder matching tolerates punctuation and legal suffix differences', () => {
  assert.equal(normalizePartnerFolderName('Example Technology Group, LLC'), 'example technology group')
  assert.equal(normalizePartnerFolderName('Example-Technology Group LLC'), 'example technology group')
  assert.equal(normalizePartnerFolderName('Ávery & Partners, Inc.'), 'avery and partners')
})

test('partner folder matching does not erase meaningful company words', () => {
  assert.notEqual(normalizePartnerFolderName('Avery Group'), normalizePartnerFolderName('Avery'))
  assert.notEqual(normalizePartnerFolderName('Avery Technologies LLC'), normalizePartnerFolderName('Avery Consulting LLC'))
})

test('partner workbook fields tolerate invisible characters and formatting differences', () => {
  const row = {
    'Partner\u00a0Name\u200b': 'Example Technology Group',
    'uei-number': 'ABC123',
    'Link to onedrive folder': 'https://example.sharepoint.com/partner',
  }

  assert.equal(partnerWorkbookValue(row, 'Partner Name'), 'Example Technology Group')
  assert.equal(partnerWorkbookValue(row, 'UEI Number'), 'ABC123')
  assert.equal(
    partnerWorkbookValue(row, 'Link to Partner Folder', 'Link to onedrive folder'),
    'https://example.sharepoint.com/partner',
  )
})
