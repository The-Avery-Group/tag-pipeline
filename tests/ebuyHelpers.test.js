import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ebuyToPipelineRecord,
  formatEbuyChangedField,
  formatEbuyCloseDuration,
  formatEbuyDateTime,
} from '../src/utils/ebuyHelpers.js'

test('maps an archived eBuy opportunity into the existing pipeline columns', () => {
  const record = ebuyToPipelineRecord({
    requestId: 'RFQ-123', requestType: 'RFQ', title: 'Example',
    buyerAgency: 'Agency', buyerDepartment: 'Department',
    buyerName: 'A Buyer', buyerEmail: 'buyer@example.gov', buyerPhone: '555-0100',
    closesAt: '2026-08-31T20:00:00.000Z', referenceNumber: 'REF-1',
    setAsideType: 'Small Business', contractType: 'Firm Fixed Price',
    vehicleSources: ['MAS'], vehiclePairs: ['MAS:541611'], description: 'Scope',
  }, 'Tracking')

  assert.equal(record['Contract Number / Notice ID'], 'RFQ-123')
  assert.equal(record['Notice Type'], 'RFQ')
  assert.equal(record['Submission Date (Response Date)*'], '2026-08-31')
  assert.equal(record['Opportunity Outlook'], 'Tracking')
  assert.equal(record['Contracting Officer / Specialist (POC)*'], 'A Buyer | buyer@example.gov | 555-0100')
})

test('formats eBuy dates in a 12-hour clock and shows time until closing', () => {
  assert.match(formatEbuyDateTime('2026-08-14T13:30:00.000Z'), /AM|PM/)
  assert.equal(
    formatEbuyCloseDuration('2026-08-16T15:00:00.000Z', new Date('2026-08-14T13:00:00.000Z')),
    'Closes in 2 days 2 hours',
  )
  assert.equal(formatEbuyChangedField('buyerAgency'), 'Agency')
})
