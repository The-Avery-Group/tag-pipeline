import assert from 'node:assert/strict'
import test from 'node:test'

import {
  chooseRepresentativeDocuments,
  compareParserOutputs,
  parserEvaluationAccess,
  parserMetrics,
} from '../src/lib/parserEvaluation.js'

test('parser evaluation samples several formats across opportunities', () => {
  const rows = [
    { opportunity_key: 'alpha', file_name: 'instructions.docx', byte_size: 100 },
    { opportunity_key: 'alpha', file_name: 'pricing.xlsx', byte_size: 90 },
    { opportunity_key: 'alpha', file_name: 'amendment.pdf', byte_size: 120 },
    { opportunity_key: 'beta', file_name: 'notice.pdf', byte_size: 80 },
    { opportunity_key: 'beta', file_name: 'response.docx', byte_size: 70 },
  ]
  const selected = chooseRepresentativeDocuments(rows, 2, 2)
  assert.equal(selected.length, 4)
  assert.equal(new Set(selected.map((row) => row.opportunity_key)).size, 2)
  assert.equal(new Set(selected.filter((row) => row.opportunity_key === 'alpha').map((row) => row.file_name.split('.').pop())).size, 2)
})

test('parser metrics retain proposal-review signals', () => {
  const text = '# Submission\n| Item | Value |\n| Email | bids@example.gov |\nQuestions are due September 8, 2026.'
  const metrics = parserMetrics(text, [{ text, location: 'section 1' }], 42, 24)
  assert.equal(metrics.headings, 1)
  assert.ok(metrics.tableRows >= 2)
  assert.equal(metrics.emails, 1)
  assert.equal(metrics.dates, 1)
  assert.equal(metrics.durationMs, 42)
  assert.equal(metrics.tokenEstimate, 24)
})

test('parser comparison flags evidence lost by Cloudflare output', () => {
  const existing = 'Submit the quotation to bids@example.gov on September 8, 2026. | Volume | Pages |'
  const cloudflare = 'Submit the quotation on September 8, 2026.'
  const comparison = compareParserOutputs(existing, cloudflare, parserMetrics(existing, [{ text: existing }]), parserMetrics(cloudflare, [{ text: cloudflare }]))
  assert.equal(comparison.recommendation, 'existing')
  assert.ok(comparison.missingSignals.includes('email addresses'))
})

test('parser evaluation reuses the restricted transaction-coding allowlist by default', () => {
  const access = parserEvaluationAccess({ email: 'reviewer@example.com' }, { TRANSACTION_CODING_ALLOWED_USERS: 'reviewer@example.com' })
  assert.deepEqual(access, { configured: true, allowed: true })
  assert.equal(parserEvaluationAccess({ email: 'other@example.com' }, { TRANSACTION_CODING_ALLOWED_USERS: 'reviewer@example.com' }).allowed, false)
})
