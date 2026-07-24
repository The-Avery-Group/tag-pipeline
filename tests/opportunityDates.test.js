import test from 'node:test'
import assert from 'node:assert/strict'
import { dateOnly, localDate, sbaProfileUrl } from '../src/utils/opportunityDates.js'

test('normalizes Excel-style timestamps to a date-only value', () => {
  assert.equal(dateOnly('2026-07-24T18:30:00.000Z'), '2026-07-24')
  assert.equal(dateOnly('2026-07-24'), '2026-07-24')
})

test('creates a local calendar date without shifting the date', () => {
  const date = localDate('2026-07-24')
  assert.equal(date.getFullYear(), 2026)
  assert.equal(date.getMonth(), 6)
  assert.equal(date.getDate(), 24)
})

test('builds an SBA entity profile link only with a valid UEI and CAGE code', () => {
  assert.equal(
    sbaProfileUrl({ uei: 'FAFSLWW6MJN4', cageCode: '5W3U5' }),
    'https://search.certifications.sba.gov/profile/FAFSLWW6MJN4/5W3U5?page=1'
  )
  assert.equal(sbaProfileUrl({ uei: 'invalid', cageCode: '5W3U5' }), 'https://search.certifications.sba.gov/')
})
