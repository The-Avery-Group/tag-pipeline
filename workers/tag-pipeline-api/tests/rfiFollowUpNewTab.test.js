import assert from 'node:assert/strict'
import test from 'node:test'

import { findLocalSAMFollowUps } from '../src/handlers/rfiFollowUpMonitor.js'
import { listEbuyFollowOnCandidates } from '../src/lib/ebuyRepository.js'
import { matchFollowOnTitles } from '../src/handlers/sam.js'

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

test('selected department and low title threshold qualify a New-tab follow-on without a hidden score floor', () => {
  const matches = findLocalSAMFollowUps([{
    'Notice ID': 'rfp-300', 'Solicitation Number': 'RFP-300',
    Title: 'Enterprise replacement acquisition', Department: 'Department of Defense',
    Agency: 'Different agency', 'Notice Type': 'RFP', 'Posted Date': '2026-03-01',
  }], {
    title: 'Enterprise logistics medical network security operations platform modernization',
    department: 'Department of Defense', agency: 'Original agency', submissionDate: '2026-01-01',
    rules: {
      departmentRule: 'Exact', agencyRule: 'Ignore', pocRule: 'Ignore',
      titleOverlapPercent: 10, submissionWindowDays: 364,
    },
  })

  assert.equal(matches.length, 1)
  assert.ok(matches[0].keywordOverlapPercent >= 10)
  assert.ok(matches[0].matchScore < 30)
})

test('title matching retains common procurement terms', () => {
  const match = matchFollowOnTitles(
    'Program support services requirement',
    'Program support service requirements',
  )
  assert.equal(match.percent, 100)
  assert.deepEqual(match.matchedTerms, ['program', 'support', 'service', 'requirement'])
})

test('title matching normalizes compounds and common abbreviations', () => {
  const match = matchFollowOnTitles(
    'Information Technology cyber security help desk services',
    'IT cybersecurity helpdesk service',
  )
  assert.equal(match.percent, 100)
})

test('title matching recognizes conservative aliases and minor spelling differences', () => {
  const aliases = matchFollowOnTitles('Cyber workforce consulting', 'Cybersecurity personnel advisory')
  const typo = matchFollowOnTitles('Enterprise modernization platform', 'Enterprise moderniztion platform')
  assert.equal(aliases.percent, 100)
  assert.ok(typo.percent >= 80)
  assert.ok(typo.matchedTerms.some((term) => term.includes('≈')))
})

test('unrelated candidate wording reduces the balanced title score', () => {
  const focused = matchFollowOnTitles('Enterprise medical logistics platform', 'Enterprise medical logistics platform')
  const padded = matchFollowOnTitles('Enterprise medical logistics platform', 'Enterprise medical logistics platform janitorial vehicle construction')
  assert.equal(focused.percent, 100)
  assert.ok(padded.percent < focused.percent)
})

test('eBuy follow-on evidence includes dismissed New-tab records', async () => {
  let query = ''
  const db = {
    prepare(sql) {
      query = sql
      return { bind() { return this }, async all() { return { results: [] } } }
    },
  }

  await listEbuyFollowOnCandidates(db, {})
  assert.doesNotMatch(query, /review_state\s*!=\s*'dismissed'/i)
})
