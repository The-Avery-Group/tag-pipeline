import assert from 'node:assert/strict'
import test from 'node:test'
import {
  applySAMSnapshot,
  buildSAMOpportunityPatch,
  dedupeSAMOpportunities,
  isSAMOpportunityFlagged,
  normalizeSAMNoticeType,
  samTypeMatches,
  sortSAMOpportunities,
} from '../src/utils/samOpportunityHelpers.js'

test('normalizes current and legacy SAM notice types', () => {
  assert.equal(normalizeSAMNoticeType('Sources Sought'), 'RFI')
  assert.equal(normalizeSAMNoticeType('Solicitation'), 'RFP')
  assert.equal(normalizeSAMNoticeType('Combined Synopsis/Solicitation'), 'RFQ')
  assert.equal(normalizeSAMNoticeType('r'), 'RFI')
  assert.equal(normalizeSAMNoticeType('o'), 'RFP')
  assert.equal(normalizeSAMNoticeType('k'), 'RFQ')
  assert.equal(normalizeSAMNoticeType('MRAS'), 'MRAS')
  assert.equal(normalizeSAMNoticeType('Market Research Notice'), 'MRAS')
  assert.equal(normalizeSAMNoticeType(['Solicitation', 'Combined Synopsis/Solicitation']), 'RFQ')
  assert.equal(normalizeSAMNoticeType(''), '')
})

test('applies a fresh SAM snapshot before displaying or adding an opportunity', () => {
  const row = { Title: 'Old', 'Notice Type': '', Agency: 'Old agency' }
  const result = applySAMSnapshot(row, {
    title: 'Current title',
    type: 'Solicitation',
    organization: 'DEPARTMENT.AGENCY.OFFICE',
  })
  assert.equal(result.Title, 'Current title')
  assert.equal(result['Notice Type'], 'RFP')
  assert.equal(result.Agency, 'AGENCY')
})

test('sorts discovery rows by newest date added and cycles response-date modes separately', () => {
  const rows = [
    { _rowIndex: 1, 'Date Added': '2026-07-20', 'Response Date': '2026-08-10' },
    { _rowIndex: 2, 'Date Added': '2026-07-25', 'Response Date': '2026-08-20' },
  ]
  assert.deepEqual(sortSAMOpportunities(rows).map((row) => row._rowIndex), [2, 1])
  assert.deepEqual(sortSAMOpportunities(rows, 'responseAsc').map((row) => row._rowIndex), [1, 2])
  assert.deepEqual(sortSAMOpportunities(rows, 'responseDesc').map((row) => row._rowIndex), [2, 1])
})

test('filters RFI and MRAS together without misclassifying unknown rows', () => {
  assert.equal(samTypeMatches({}, 'RFI'), false)
  assert.equal(samTypeMatches({ 'Notice Type': 'RFI' }, 'RFI_MRAS'), true)
  assert.equal(samTypeMatches({ 'Notice Type': 'MRAS' }, 'RFI_MRAS'), true)
  assert.equal(samTypeMatches({ 'Notice Type': 'RFP' }, 'RFI'), false)
  assert.equal(samTypeMatches({ 'Notice Type': 'RFQ' }, 'All'), true)
})

test('collapses duplicate discovery rows without merging an RFI into its RFP follow-on', () => {
  const rows = [
    { _rowIndex: 1, 'Notice ID': 'same', 'Solicitation Number': 'ABC-1', 'Notice Type': 'k', Status: 'new' },
    { _rowIndex: 2, 'Notice ID': 'same', 'Solicitation Number': 'ABC-1', 'Notice Type': 'RFQ', Status: 'dismissed' },
    { _rowIndex: 3, 'Notice ID': 'rfi', 'Solicitation Number': 'ABC-1', 'Notice Type': 'RFI', Status: 'new' },
  ]

  const result = dedupeSAMOpportunities(rows)
  assert.deepEqual(result.map((row) => row._rowIndex).sort(), [2, 3])
})

test('recognizes shared flags and preserves them when duplicate rows collapse', () => {
  assert.equal(isSAMOpportunityFlagged('Yes'), true)
  assert.equal(isSAMOpportunityFlagged(''), false)

  const result = dedupeSAMOpportunities([
    { _rowIndex: 1, 'Notice ID': 'same', 'Solicitation Number': 'ABC-1', 'Notice Type': 'RFI', Status: 'new', Flagged: 'Yes', 'Posted Date': '2026-07-20' },
    { _rowIndex: 2, 'Notice ID': 'same', 'Solicitation Number': 'ABC-1', 'Notice Type': 'RFI', Status: 'new', Flagged: '', 'Posted Date': '2026-07-21' },
  ])

  assert.equal(result.length, 1)
  assert.equal(result[0]._rowIndex, 2)
  assert.equal(result[0].Flagged, 'Yes')
})

test('builds a reviewable pipeline patch without replacing the contract identifier', () => {
  const columns = {
    noticeType: 'Notice Type',
    contractNum: 'Contract',
    title: 'Title',
    solNum: 'Solicitation',
    setAside: 'Set Aside',
    department: 'Department',
    agency: 'Agency',
    office: 'Office',
    naics: 'NAICS',
    submDate: 'Response',
    otherLinks: 'Links',
  }
  const result = buildSAMOpportunityPatch({
    Contract: 'KEEP-ME',
    Title: 'Old',
    Links: 'https://example.com',
  }, {
    title: 'New',
    noticeId: 'DO-NOT-USE',
    uiLink: 'https://sam.gov/opp/123/view',
  }, columns)
  assert.equal(result.patch.Contract, undefined)
  assert.equal(result.patch.Title, 'New')
  assert.equal(result.patch['Notice Type'], undefined)
  assert.match(result.patch.Links, /sam\.gov/)
})
