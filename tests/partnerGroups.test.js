import test from 'node:test'
import assert from 'node:assert/strict'
import { groupPartners, sharedPartnerWorkspace, partnerProfilePath } from '../src/utils/partnerGroups.js'

test('groups only explicit company groups and retains all subsidiary records', () => {
  const partners = [
    { 'Partner Name': 'Tanaq A', 'UEI Number': 'A', 'Partner Group': 'Tanaq' },
    { 'Partner Name': 'Tanaq B', 'UEI Number': 'B', 'Partner Group': 'tanaq' },
    { 'Partner Name': 'Tanaq unrelated', 'UEI Number': 'C' },
  ]
  const groups = groupPartners(partners)
  assert.equal(groups.length, 2)
  assert.equal(groups[0].members.length, 2)
  assert.equal(partners[1]['UEI Number'], 'B')
})
test('one existing workspace can be shared without editing rows; conflicting links are not merged', () => {
  const a = { 'Link to Partner Folder': 'https://example.com/shared' }
  assert.equal(sharedPartnerWorkspace([{}, a]).partner, a)
  assert.deepEqual(sharedPartnerWorkspace([a, { 'Link to Partner Folder': 'https://example.com/other' }]), { partner: null, conflict: true })
})
test('search routes directly to the matched subsidiary', () => {
  assert.equal(partnerProfilePath({ 'UEI Number': 'ABC123' }), '/partners?partner=ABC123')
})
