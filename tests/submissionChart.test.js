import assert from 'node:assert/strict'
import test from 'node:test'
import { computeSubmissionsByMonth } from '../src/utils/kpiHelpers.js'

test('submission chart keeps one total and a notice-type tooltip breakdown', () => {
  const today = new Date()
  const date = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-15`
  const rows = [
    { 'Notice Type': 'RFI', 'TAG Pipeline Activity Phase': 'Submitted RFI', 'Submission Date (Response Date)*': date },
    { 'Notice Type': 'RFP', 'TAG Pipeline Activity Phase': 'Submitted RFP', 'Submission Date (Response Date)*': date },
    { 'Notice Type': 'RFI', 'TAG Pipeline Activity Phase': 'Pre-RFP', 'Submission Date (Response Date)*': date },
  ]

  const current = computeSubmissionsByMonth(rows, 1)[0]
  assert.equal(current.count, 2)
  assert.deepEqual(current.types, { RFI: 1, RFP: 1 })
})
