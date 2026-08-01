import assert from 'node:assert/strict'
import test from 'node:test'
import { buildFollowUpDraft, mergeFollowUpTemplate } from '../src/utils/followUpEmails.js'

test('merges both singular and plural contact-name fields', () => {
  const context = { contactFirstName: 'Alex and Morgan' }
  assert.equal(
    mergeFollowUpTemplate('{{contact_first_name}} | {{contact_first_names}}', context),
    'Alex and Morgan | Alex and Morgan',
  )
})

test('builds a manual follow-up draft for every selected POC', () => {
  const draft = buildFollowUpDraft({
    opportunity: {
      'Contract Number / Notice ID': 'ABC-123',
      'Project Title / Description*': 'Test RFI',
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
      { name: 'Taylor Person', email: 'taylor@example.gov' },
    ],
  })

  assert.equal(draft.To, 'alex@example.gov; morgan@example.gov; taylor@example.gov')
  assert.equal(draft.Body, 'Hello Alex, Morgan, and Taylor')
})
