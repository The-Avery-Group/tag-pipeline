import test from 'node:test'
import assert from 'node:assert/strict'
import { dateOnly, localDate, sbaProfileUrl } from '../src/utils/opportunityDates.js'
import { formatDate } from '../src/utils/kpiHelpers.js'

test('award dates normalize Excel numbers and cached numeric strings for display and editing', () => {
  const serial = Date.UTC(2026, 8, 1) / 86400000 + 25569
  for (const value of [serial, String(serial), serial + 0.5]) {
    assert.equal(dateOnly(value), '2026-09-01')
    assert.equal(formatDate(dateOnly(value)), 'Sep 1, 2026')
  }
  assert.equal(dateOnly(''), '')
  assert.equal(dateOnly(null), '')
  assert.equal(dateOnly('2026-09-01T23:00:00-04:00'), '2026-09-01')
})

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
