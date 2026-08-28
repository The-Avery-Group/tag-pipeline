import assert from 'node:assert/strict'
import test from 'node:test'

import { preserveSAMChangeReview } from '../src/handlers/samMonitor.js'

test('an acknowledged SAM change remains acknowledged when the same revision is seen again', () => {
  const reviewedAt = '2027-01-02T12:00:00.000Z'
  const previous = {
    fields: ['title', 'responseDate'],
    sourceModifiedAt: '2027-01-01T12:00:00.000Z',
    reviewedAt,
  }
  const candidate = {
    fields: ['responseDate', 'title'],
    sourceModifiedAt: '2027-01-01T12:00:00.000Z',
  }
  assert.equal(preserveSAMChangeReview(previous, candidate, {}).reviewedAt, reviewedAt)
})

test('a genuinely new SAM revision is not pre-acknowledged', () => {
  const previous = {
    fields: ['title'],
    sourceModifiedAt: '2027-01-01T12:00:00.000Z',
    reviewedAt: '2027-01-02T12:00:00.000Z',
  }
  const candidate = {
    fields: ['title'],
    sourceModifiedAt: '2027-01-03T12:00:00.000Z',
  }
  assert.equal(preserveSAMChangeReview(previous, candidate, {}).reviewedAt, null)
})

test('an acknowledged SAM fingerprint remains durable even if source date formatting varies', () => {
  const snapshot = { title: 'Current title', modifiedDate: '2027-01-01T12:00:00Z' }
  const reviewed = preserveSAMChangeReview(null, {
    fields: ['title'],
    sourceModifiedAt: '2027-01-01T12:00:00Z',
  }, snapshot)
  reviewed.reviewedAt = '2027-01-02T12:00:00Z'
  reviewed.reviewedFingerprint = reviewed.fingerprint

  const repeated = preserveSAMChangeReview(reviewed, {
    fields: ['title'],
    sourceModifiedAt: 'January 1, 2027 12:00 UTC',
  }, snapshot)
  assert.equal(repeated.reviewedAt, reviewed.reviewedAt)
  assert.equal(repeated.reviewedFingerprint, reviewed.fingerprint)
})
