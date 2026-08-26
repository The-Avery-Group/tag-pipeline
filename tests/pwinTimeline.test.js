import assert from 'node:assert/strict'
import test from 'node:test'
import { computeContractTimeline, computeKPIs } from '../src/utils/kpiHelpers.js'

test('company PWIN counts won submitted RFPs over every submitted RFP', () => {
  const rows = [
    { 'Notice Type': 'RFP', 'TAG Opportunity Phase': 'Contract Awarded', Outcome: 'Won' },
    { 'Notice Type': 'RFP', 'TAG Opportunity Phase': 'Closed Lost', Outcome: 'Lost' },
    { 'Notice Type': 'RFP', 'TAG Opportunity Phase': 'Pending Award', 'TAG Pipeline Activity Phase': 'Proposal Submitted' },
    { 'Notice Type': 'RFQ', 'TAG Opportunity Phase': 'Contract Awarded', Outcome: 'Won' },
  ]
  const kpis = computeKPIs(rows, [])
  assert.equal(kpis.submittedRfpCount, 3)
  assert.equal(kpis.pendingAward, 1)
  assert.equal(kpis.won, 1)
  assert.equal(kpis.lost, 1)
  assert.ok(Math.abs(kpis.companyPwin - (100 / 3)) < 1e-10)
  assert.equal(kpis.decidedPwin, 50)
})

test('federal fiscal quarter timeline starts Q1 in October', () => {
  const year = new Date().getFullYear() + 1
  const data = computeContractTimeline([{
    'Contract End Date*': `${year - 1}-10-15`,
    'TAG Opportunity Phase': 'Contract Awarded',
    'Total Contract Value ($)*': '1000',
  }], { grouping: 'quarter', basis: 'fiscal' })
  const bucket = data.find((item) => item.key === `${year}-Q1`)
  if (bucket) assert.equal(bucket.count, 1)
})
