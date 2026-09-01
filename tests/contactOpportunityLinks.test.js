import test from 'node:test'
import assert from 'node:assert/strict'
import {
  findOpportunitiesForContact,
  opportunityHasLinkedContact,
  parsePOCNames,
} from '../src/utils/contactOpportunityLinks.js'

test('shared contact relationship parser matches the CRM comma-separated POC field', () => {
  const opportunity = {
    'Contracting Officer / Specialist (POC)*': 'John Doe, Amanda Haynes',
  }
  assert.deepEqual(parsePOCNames(opportunity['Contracting Officer / Specialist (POC)*']), ['John Doe', 'Amanda Haynes'])
  assert.equal(opportunityHasLinkedContact(opportunity, 'Amanda Haynes'), true)
})

test('contact page and AI query can share the same opportunity resolver', () => {
  const pipeline = [
    { id: 1, 'Contracting Officer / Specialist (POC)*': 'Amanda Haynes' },
    { id: 2, 'Contracting Officer / Specialist (POC)*': 'Another Person, Amanda Haynes' },
    { id: 3, 'Contracting Officer / Specialist (POC)*': 'Amanda Jones' },
  ]
  assert.deepEqual(findOpportunitiesForContact(pipeline, ' Amanda  Haynes ').map((item) => item.id), [1, 2])
})
