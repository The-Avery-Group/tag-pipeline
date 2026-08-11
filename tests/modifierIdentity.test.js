import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveModifierWithCrmContacts } from '../src/utils/modifierIdentity.js'

test('resolves an HHS modifier identifier from CRM contacts', () => {
  const result = resolveModifierWithCrmContacts(
    { raw: 'HHSAHAYNES', status: 'unresolved', matches: [] },
    'CENTERS FOR DISEASE CONTROL AND PREVENTION',
    [{ ContactID: 'C-1', Name: 'Amanda Haynes', Email: 'amanda.haynes@hhs.gov', Agency: 'CDC' }],
  )
  assert.equal(result.status, 'matched')
  assert.equal(result.matches[0].name, 'Amanda Haynes')
  assert.equal(result.matches[0].sourceLabel, 'CRM contacts')
})

test('resolves an agency email modifier from CRM contacts', () => {
  const result = resolveModifierWithCrmContacts(
    { raw: 'buyer@army.mil', status: 'unresolved', matches: [] },
    'DEPT OF THE ARMY',
    [{ ContactID: 'C-2', Name: 'Jordan Buyer', Email: 'buyer@army.mil', Agency: 'Army' }],
  )
  assert.equal(result.status, 'matched')
  assert.equal(result.matches[0].name, 'Jordan Buyer')
})

test('returns all distinct notice and CRM matches for user selection', () => {
  const result = resolveModifierWithCrmContacts(
    { raw: 'HHSAHAYNES', status: 'matched', matches: [{ name: 'Alex Haynes', email: 'alex@hhs.gov', noticeId: 'NOTICE-1' }] },
    'NATIONAL INSTITUTES OF HEALTH',
    [{ ContactID: 'C-3', Name: 'Amanda Haynes', Email: 'amanda@hhs.gov', Agency: 'NIH' }],
  )
  assert.equal(result.status, 'multiple')
  assert.equal(result.matches.length, 2)
})
