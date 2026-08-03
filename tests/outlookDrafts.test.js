import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildOutlookDraftPayload,
  outlookPopoutUrl,
  parseEmailAddresses,
} from '../src/utils/outlookDrafts.js'

test('builds a formatted Outlook draft payload with unique recipients', () => {
  const payload = buildOutlookDraftPayload({
    from: 'procurement@example.com',
    to: 'first@example.gov; second@example.gov; FIRST@example.gov',
    cc: 'reviewer@example.com',
    subject: 'Follow-up',
    body: '<p>Hello</p>',
    draftId: 'FU-ABC-21',
    includeTrackingHeader: true,
  })

  assert.equal(payload.from.emailAddress.address, 'procurement@example.com')
  assert.deepEqual(
    payload.toRecipients.map((recipient) => recipient.emailAddress.address),
    ['first@example.gov', 'second@example.gov'],
  )
  assert.equal(payload.body.contentType, 'HTML')
  assert.equal(payload.internetMessageHeaders[0].value, 'FU-ABC-21')
})

test('rejects invalid recipients before calling Outlook', () => {
  assert.throws(() => buildOutlookDraftPayload({
    from: 'procurement@example.com',
    to: 'not-an-email',
    subject: 'Follow-up',
    body: '<p>Hello</p>',
  }), /valid recipient/)
})

test('adds the Outlook popout flag without discarding existing parameters', () => {
  const url = outlookPopoutUrl('https://outlook.office.com/mail/deeplink/compose?id=123')
  assert.match(url, /id=123/)
  assert.match(url, /ispopout=1/)
})

test('parses comma and semicolon separated addresses', () => {
  assert.deepEqual(parseEmailAddresses('a@example.com, b@example.com; a@example.com'), [
    'a@example.com',
    'b@example.com',
  ])
})
