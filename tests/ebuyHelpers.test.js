import assert from 'node:assert/strict'
import test from 'node:test'
import {
  awaitingEbuySyncStart,
  ebuySurveyWarning,
  ebuyToPipelineRecord,
  formatEbuyAttachmentMeta,
  formatEbuyChangedField,
  formatEbuyCloseDuration,
  formatEbuyDateTime,
  normalizeEbuyNoticeType,
} from '../src/utils/ebuyHelpers.js'

test('keeps polling through the queued workflow gap without ignoring current completion', () => {
  const requestedAt = Date.parse('2026-09-11T12:00:00Z')
  const oldRun = { lastSync: { status: 'success', started_at: '2026-09-10T12:00:00Z' } }
  assert.equal(awaitingEbuySyncStart(oldRun, requestedAt, requestedAt + 1000), true)
  assert.equal(awaitingEbuySyncStart({}, requestedAt, requestedAt + 1000), true)
  assert.equal(awaitingEbuySyncStart(oldRun, requestedAt, requestedAt + 31000), false)
  assert.equal(awaitingEbuySyncStart(oldRun, 0, requestedAt), false)
  assert.equal(awaitingEbuySyncStart({ lastSync: { status: 'success', started_at: '2026-09-11T12:00:01Z' } }, requestedAt, requestedAt + 2000), false)
})

test('hides survey security challenges but preserves actual download issues', () => {
  const challenge = 'https://feedback.gsa.gov/jfe/form/example: GSA requires a browser security check before exposing these documents. Open the survey link to access them.'
  assert.equal(ebuySurveyWarning({ status: 'needs_attention', error: challenge }), '')
  assert.equal(ebuySurveyWarning({ status: 'ready' }), '')
  assert.equal(ebuySurveyWarning({ status: 'needs_attention', error: `${challenge}; File.pdf: Download failed` }), 'File.pdf: Download failed')
  assert.equal(ebuySurveyWarning({ status: 'needs_attention', error: 'Download failed' }), 'Download failed')
  assert.match(ebuySurveyWarning({ status: 'needs_attention' }), /did not expose/)
})

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

test('attachment metadata omits an unavailable size once the file is archived', () => {
  assert.equal(formatEbuyAttachmentMeta({ archiveStatus: 'archived', byteSize: null }), 'Archived')
  assert.equal(formatEbuyAttachmentMeta({ archiveStatus: 'archived', byteSize: 2049 }), '3 KB · Archived')
  assert.equal(formatEbuyAttachmentMeta({ archiveStatus: 'pending', byteSize: null }), 'Awaiting archive')
})

test('classifies eBuy market research records as MRAS even when eBuy labels the request RFI', () => {
  const opportunity = {
    requestId: 'RFI1234567',
    requestType: 'RFI',
    title: 'Market Research as a Service for program support',
  }
  assert.equal(normalizeEbuyNoticeType(opportunity), 'MRAS')
  assert.equal(ebuyToPipelineRecord(opportunity)['Notice Type'], 'MRAS')
  assert.equal(normalizeEbuyNoticeType({ requestType: 'RFI', title: 'Program support services' }), 'RFI')
})
