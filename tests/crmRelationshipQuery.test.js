import test from 'node:test'
import assert from 'node:assert/strict'
import { answerDeterministicCrmQuery, createCrmRelationshipQuery, queryCrmRelationships } from '../src/services/crmRelationshipQuery.js'

const data = {
  readiness: { pipeline: true, contacts: true, tasks: true, notes: true },
  contacts: [
    { ContactID: 'C-1', Name: 'Amanda Haynes', Title: 'Contracting Officer', Agency: 'VA', Email: 'amanda@example.gov', Phone: '555-0100' },
    { ContactID: 'C-2', Name: 'Amanda Jones', Agency: 'DOD' },
  ],
  pipeline: [
    { 'Opportunity ID': 'O-1', 'Project Title / Description*': 'Insurance Support', 'Contract Number / Notice ID': 'VA-001', 'Contract End Date*': '2027-09-30', 'Total Contract Value ($)*': '$2,000,000', 'Contracting Officer / Specialist (POC)*': 'Amanda Haynes', 'Agency*': 'VA' },
    { 'Opportunity ID': 'O-2', 'Project Title / Description*': 'Claims Processing', 'Contract Number / Notice ID': 'VA-002', 'Contract End Date*': '2028-03-31', 'Total Contract Value ($)*': 750000, 'Contracting Officer / Specialist (POC)*': 'John Doe, Amanda Haynes', 'Agency*': 'VA' },
    { 'Opportunity ID': 'O-3', 'Project Title / Description*': 'Archived Work', 'Contract Number / Notice ID': 'VA-003', 'Contracting Officer / Specialist (POC)*': 'Amanda Haynes', Archived: 'Yes' },
  ],
}

test('reverse contact relationship returns linked active contracts with requested fields', () => {
  const result = createCrmRelationshipQuery(data).getContactContracts({ query: 'Amanda Haynes' })
  assert.equal(result.status, 'ready')
  assert.equal(result.contactFound, true)
  assert.equal(result.linkedOpportunityCount, 2)
  assert.deepEqual(result.opportunities.map(({ title, contractNumber, expiryDate, value }) => ({ title, contractNumber, expiryDate, value })), [
    { title: 'Insurance Support', contractNumber: 'VA-001', expiryDate: '2027-09-30', value: '$2,000,000' },
    { title: 'Claims Processing', contractNumber: 'VA-002', expiryDate: '2028-03-31', value: 750000 },
  ])
})

test('contact not found differs from a found contact with no contracts', () => {
  const query = createCrmRelationshipQuery(data)
  assert.equal(query.getContactContracts({ query: 'Missing Person' }).status, 'not_found')
  const found = query.getContactContracts({ query: 'Amanda Jones' })
  assert.equal(found.status, 'ready')
  assert.equal(found.contactFound, true)
  assert.equal(found.linkedOpportunityCount, 0)
})

test('legacy contact search results include reverse-linked contracts', () => {
  const result = createCrmRelationshipQuery(data).searchContacts('Amanda Haynes')
  assert.equal(result.contacts[0].linkedOpportunityCount, 2)
  assert.deepEqual(result.contacts[0].linkedOpportunities.map((opportunity) => opportunity.contractNumber), ['VA-001', 'VA-002'])
})

test('contact contract table requests are answered deterministically without an AI tool decision', () => {
  const answer = answerDeterministicCrmQuery(
    'I need a table of all the contracts that currently have Amanda Haynes as their contact. title, contract number, expiry date, value',
    data
  )
  assert.match(answer, /\| Title \| Contract number \| Expiry date \| Value \|/)
  assert.match(answer, /\| Insurance Support \| VA-001 \| 2027-09-30 \| \$2,000,000 \|/)
  assert.match(answer, /\| Claims Processing \| VA-002 \| 2028-03-31 \| 750000 \|/)
  assert.doesNotMatch(answer, /VA-003/)
})

test('POC evidence can answer even when the separate contact row is missing', () => {
  const answer = answerDeterministicCrmQuery(
    'Show contracts associated with Amanda Haynes as contact',
    { ...data, contacts: [] }
  )
  assert.match(answer, /Insurance Support/)
  assert.match(answer, /Claims Processing/)
})

test('unavailable tables are never reported as zero results', () => {
  const result = queryCrmRelationships({ ...data, readiness: { contacts: true, pipeline: false } }, {
    entityType: 'contact', query: 'Amanda Haynes',
  })
  assert.equal(result.status, 'data_unavailable')
  assert.equal(result.dataReady, false)
  assert.equal('linkedOpportunityCount' in result, false)
})

test('opportunity traversal joins contacts, tasks, notes, related opportunities, partners, and interactions', () => {
  const result = queryCrmRelationships({
    ...data,
    tasks: [{ ContractNumber: 'VA-001', Title: 'Review' }],
    notes: [{ ContractNumber: 'VA-001', NoteText: 'Call complete' }],
    relationships: [{ 'Opportunity ID': 'O-1', 'Related Opportunity ID': 'O-2', 'Relationship Type': 'Follow-on' }],
    partners: [{ 'Partner Name': 'Acme', 'UEI Number': 'UEI1' }],
    interactions: [{ ContactID: 'C-1', 'Interaction Type': 'Email' }],
  }, { entityType: 'opportunity', query: 'VA-001' })
  assert.equal(result.opportunityFound, true)
  assert.equal(result.contacts[0].name, 'Amanda Haynes')
  assert.equal(result.tasks.length, 1)
  assert.equal(result.notes.length, 1)
  assert.equal(result.relatedOpportunities[0].contractNumber, 'VA-002')
  assert.equal(result.contactInteractions.length, 1)
})
