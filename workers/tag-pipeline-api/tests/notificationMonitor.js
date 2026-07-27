import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildNotificationRecipientDirectory,
  resolveNotificationRecipients,
} from '../src/handlers/notificationMonitor.js'
import { cardForType } from '../src/handlers/notify.js'

test('scheduled recipient mappings resolve short and display names to one Teams identity', () => {
  const directory = buildNotificationRecipientDirectory([
    {
      'Pipeline Assignee': 'Ayomide',
      'Teams Display Name': 'Ayomide Gbadegesin',
      'Teams UPN / Entra Object ID': 'ayomide@example.com',
      'Mention Enabled': 'Yes',
    },
  ])

  const recipients = resolveNotificationRecipients(directory, ['Ayomide', 'Ayomide Gbadegesin'])

  assert.deepEqual(recipients, [{
    name: 'Ayomide Gbadegesin',
    id: 'ayomide@example.com',
  }])
})

test('recipient mapping tolerates trimmed header variants used by existing workbooks', () => {
  const directory = buildNotificationRecipientDirectory([
    {
      'Pipeline Assignee ': 'AO',
      'Full Name': 'A O',
      Email: 'ao@example.com',
      'Mention Enabled ': true,
    },
  ])

  assert.deepEqual(resolveNotificationRecipients(directory, ['AO']), [{
    name: 'A O',
    id: 'ao@example.com',
  }])
})

test('scheduled RFI cards keep mention tokens aligned with Teams entities', () => {
  const recipient = { name: 'Ayomide Gbadegesin', id: 'ayomide@example.com' }
  const card = cardForType('rfi_response_due', {
    title: 'Example RFI',
    contractNumber: 'ABC-123',
    agency: 'Example Agency',
    responseDate: '2026-07-28',
    daysUntil: 1,
    recipients: [recipient, recipient],
  }, { ALLOWED_ORIGIN: 'https://example.com' })

  const content = card.attachments[0].content
  assert.equal(content.msteams.entities.length, 1)
  assert.equal(content.msteams.entities[0].mentioned.id, 'ayomide@example.com')
  assert.equal(JSON.stringify(content.body).split('<at>Ayomide Gbadegesin</at>').length - 1, 1)
})

test('scheduled cards still render when no mention identity is configured', () => {
  const card = cardForType('rfi_response_due', {
    title: 'Example RFI',
    contractNumber: 'ABC-123',
    agency: 'Example Agency',
    responseDate: '2026-07-28',
    daysUntil: 1,
    recipients: [{ name: 'Ayomide', id: '' }],
  }, { ALLOWED_ORIGIN: 'https://example.com' })

  const content = card.attachments[0].content
  assert.equal(content.msteams, undefined)
  assert.match(JSON.stringify(content.body), /@Ayomide/)
})
