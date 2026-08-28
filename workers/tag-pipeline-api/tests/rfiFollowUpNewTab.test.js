import assert from 'node:assert/strict'
import test from 'node:test'

import { findLocalSAMFollowUps } from '../src/handlers/rfiFollowUpMonitor.js'

test('follow-on matching uses RFP and RFQ records already present in the New tab', () => {
  const source = {
    title: 'Enterprise cyber security support services',
    department: 'Department of Defense',
    agency: 'Defense Health Agency',
    solicitationNumber: 'DHA-RFI-100',
    submissionDate: '2026-01-01',
    rules: {
      departmentRule: 'Exact', agencyRule: 'Exact', pocRule: 'Ignore',
      titleOverlapPercent: 40, submissionWindowDays: 364,
    },
  }
  const rows = [{
    'Notice ID': 'rfp-200',
    'Solicitation Number': 'DHA-RFP-200',
    Title: 'Enterprise cyber security support services',
    Department: 'Department of Defense',
    Agency: 'Defense Health Agency',
    'Notice Type': 'RFP',
    'Posted Date': '2026-03-01',
    'SAM.gov URL': 'https://sam.gov/opp/rfp-200',
  }]
  const matches = findLocalSAMFollowUps(rows, source)
  assert.equal(matches.length, 1)
  assert.equal(matches[0].noticeId, 'rfp-200')
  assert.equal(matches[0].source, 'SAM.gov')
})

test('follow-on matching ignores RFI rows in the New tab', () => {
  const matches = findLocalSAMFollowUps([{
    'Notice ID': 'rfi-2', Title: 'Cyber security support', Department: 'DOD', Agency: 'DHA',
    'Notice Type': 'RFI', 'Posted Date': '2026-03-01',
  }], {
    title: 'Cyber security support', department: 'DOD', agency: 'DHA', submissionDate: '2026-01-01',
    rules: { departmentRule: 'Exact', agencyRule: 'Exact', pocRule: 'Ignore', titleOverlapPercent: 40, submissionWindowDays: 364 },
  })
  assert.deepEqual(matches, [])
})
