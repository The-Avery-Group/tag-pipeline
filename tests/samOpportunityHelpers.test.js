import assert from 'node:assert/strict'
import test from 'node:test'
import {
  applySAMSnapshot,
  buildSAMOpportunityPatch,
  normalizeSAMNoticeType,
  samTypeMatches,
  sortSAMOpportunities,
} from '../src/utils/samOpportunityHelpers.js'

test('normalizes current and legacy SAM notice types', () => {
  assert.equal(normalizeSAMNoticeType('Sources Sought'), 'RFI')
  assert.equal(normalizeSAMNoticeType('Solicitation'), 'RFP')
  assert.equal(normalizeSAMNoticeType('Combined Synopsis/Solicitation'), 'RFQ')
  assert.equal(normalizeSAMNoticeType(''), 'RFI')
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

test('defaults legacy discovery rows to the RFI filter', () => {
  assert.equal(samTypeMatches({}, 'RFI'), true)
  assert.equal(samTypeMatches({ 'Notice Type': 'RFP' }, 'RFI'), false)
  assert.equal(samTypeMatches({ 'Notice Type': 'RFQ' }, 'All'), true)
})

test('builds a reviewable pipeline patch without replacing the contract identifier', () => {
  const columns = {
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
  assert.match(result.patch.Links, /sam\.gov/)
})
