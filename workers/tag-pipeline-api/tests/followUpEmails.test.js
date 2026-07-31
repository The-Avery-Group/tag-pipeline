import assert from 'node:assert/strict'
import test from 'node:test'
import { buildScheduledDraft, deterministicDraftId, formatRecipientNames, mergeTemplate } from '../src/lib/followUpEmails.js'

test('creates a stable draft identity for the same opportunity and template', () => {
  assert.equal(
    deterministicDraftId('ABC 123', 'Template:21'),
    deterministicDraftId('ABC 123', 'Template:21'),
  )
})

test('merges only supported follow-up fields', () => {
  assert.equal(
    mergeTemplate('Hello {{contact_first_name}}, {{unknown}}', { contactFirstName: 'Ayo' }),
    'Hello Ayo, {{unknown}}',
  )
})

test('formats multiple recipient first names naturally', () => {
  assert.equal(formatRecipientNames(['Alex', 'Morgan']), 'Alex and Morgan')
  assert.equal(formatRecipientNames(['Alex', 'Morgan', 'Taylor']), 'Alex, Morgan, and Taylor')
})

test('builds a ready draft when its due date has arrived', () => {
  const draft = buildScheduledDraft({
    opportunity: {
      'Contract Number / Notice ID': 'ABC-123',
      'Project Title / Description*': 'Test RFI',
      'Submission Date (Response Date)*': '2026-07-01',
      'Agency*': 'Test Agency',
      'Other Links*': 'https://sam.gov/example',
    },
    template: {
      'Template ID': 'FUT-21',
      'Template Name': '21 day follow-up',
      'Days After Submission': 21,
      Subject: 'Following up on {{opportunity_title}}',
      Body: 'Hello {{contact_first_name}}',
    },
    recipient: { name: 'Alex Person', email: 'alex@example.gov' },
    today: '2026-07-30',
    now: '2026-07-30T12:00:00.000Z',
  })
  assert.equal(draft.Status, 'Ready for review')
  assert.equal(draft['Due Date'], '2026-07-22')
  assert.equal(draft.To, 'alex@example.gov')
})

test('builds one draft for multiple recipients and merges all first names', () => {
  const draft = buildScheduledDraft({
    opportunity: {
      'Contract Number / Notice ID': 'ABC-456',
      'Project Title / Description*': 'Another RFI',
      'Submission Date (Response Date)*': '2026-07-01',
      'Agency*': 'Test Agency',
    },
    template: {
      'Template ID': 'FUT-21',
      'Template Name': '21 day follow-up',
      'Days After Submission': 21,
      Subject: 'Follow-up',
      Body: 'Hello {{contact_first_name}}',
    },
    recipients: [
      { name: 'Alex Person', email: 'alex@example.gov' },
      { name: 'Morgan Person', email: 'morgan@example.gov' },
    ],
    today: '2026-07-30',
    now: '2026-07-30T12:00:00.000Z',
  })
  assert.equal(draft.To, 'alex@example.gov; morgan@example.gov')
  assert.equal(draft.Body, 'Hello Alex and Morgan')
})
