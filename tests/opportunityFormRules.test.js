import test from 'node:test'
import assert from 'node:assert/strict'
import { needsRfiActivityPhasePrompt } from '../src/utils/opportunityFormRules.js'

const columns = { phase: 'phase', outlook: 'outlook', submissionDate: 'submissionDate', activityPhase: 'activityPhase' }

test('prompts when a new RFI submission date is entered without an activity phase', () => {
  assert.equal(needsRfiActivityPhasePrompt(
    { phase: 'Identified', outlook: 'New', submissionDate: '' },
    { phase: 'Identified', outlook: 'New', submissionDate: '2026-07-24', activityPhase: '' },
    columns,
  ), true)
})

test('does not prompt when the activity phase is already provided or the record is not a new RFI', () => {
  assert.equal(needsRfiActivityPhasePrompt(
    { phase: 'Identified', outlook: 'New', submissionDate: '' },
    { phase: 'Identified', outlook: 'New', submissionDate: '2026-07-24', activityPhase: 'Submitted RFI' },
    columns,
  ), false)
})
