import assert from 'node:assert/strict'
import test from 'node:test'
import {
  containsGenericEmailPlaceholder,
  emailHtmlToText,
  plainTextToEmailHtml,
  protectEmailHtmlForAI,
  restoreProtectedEmailHtml,
} from '../src/utils/emailHtml.js'

test('converts existing plain-text drafts into email HTML without losing line breaks', () => {
  const html = plainTextToEmailHtml('Dear Alex,\n\nThank you.\nBest regards,\nAyomide')
  assert.match(html, /^<p>Dear Alex,<\/p>/)
  assert.match(html, /Thank you\.<br>Best regards,<br>Ayomide/)
  assert.equal(emailHtmlToText(html), 'Dear Alex,\nThank you.\nBest regards,\nAyomide')
})

test('protects and restores greetings, tables, and signatures around an AI rewrite', () => {
  const original = [
    '<p>Dear Alex,</p>',
    '<p>Please review the opportunities below.</p>',
    '<table><thead><tr><th>Opportunity</th></tr></thead><tbody><tr><td>Esports</td></tr></tbody></table>',
    '<div data-email-signature="true"><p>Best regards,<br>Ayomide</p></div>',
  ].join('')
  const protectedDraft = protectEmailHtmlForAI(original)

  assert.equal(protectedDraft.fragments.length, 3)
  const rewritten = protectedDraft.html.replace('Please review the opportunities below.', 'Please find the opportunity details below.')
  const restored = restoreProtectedEmailHtml(rewritten, protectedDraft.fragments)

  assert.match(restored, /Dear Alex,/)
  assert.match(restored, /<table>/)
  assert.match(restored, /Esports/)
  assert.match(restored, /data-email-signature="true"/)
  assert.match(restored, /Please find the opportunity details below\./)
})

test('rejects generic sender placeholders in AI-generated email content', () => {
  assert.equal(containsGenericEmailPlaceholder('<p>Best regards,<br>[Your Name]<br>[Email]</p>'), true)
  assert.equal(containsGenericEmailPlaceholder('<p>Best regards,<br>Ayomide</p>'), false)
})

test('fails restoration when AI removes protected email content', () => {
  const protectedDraft = protectEmailHtmlForAI('<p>Dear Alex,</p><p>Hello there.</p>')
  assert.throws(
    () => restoreProtectedEmailHtml('<p>Hello there.</p>', protectedDraft.fragments),
    /did not preserve protected email content/,
  )
})
