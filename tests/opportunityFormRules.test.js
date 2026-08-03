import test from 'node:test'
import assert from 'node:assert/strict'
import { needsRfiActivityPhasePrompt } from '../src/utils/opportunityFormRules.js'

const columns = { noticeType: 'noticeType', submissionDate: 'submissionDate', activityPhase: 'activityPhase' }

test('prompts when a new RFI submission date is entered without an activity phase', () => {
  assert.equal(needsRfiActivityPhasePrompt(
    { noticeType: 'RFI', submissionDate: '' },
    { noticeType: 'RFI', submissionDate: '2026-07-24', activityPhase: '' },
    columns,
  ), true)
})

test('MRAS shares the RFI workflow and other notice types do not prompt', () => {
  assert.equal(needsRfiActivityPhasePrompt(
    { noticeType: 'MRAS', submissionDate: '' },
    { noticeType: 'MRAS', submissionDate: '2026-07-24', activityPhase: '' },
    columns,
  ), true)
  assert.equal(needsRfiActivityPhasePrompt(
    { noticeType: 'RFP', submissionDate: '' },
    { noticeType: 'RFP', submissionDate: '2026-07-24', activityPhase: '' },
    columns,
  ), false)
})

test('prompts when an existing dated opportunity is newly classified as RFI or MRAS', () => {
  assert.equal(needsRfiActivityPhasePrompt(
    { noticeType: '', submissionDate: '2026-07-24', activityPhase: '' },
    { noticeType: 'MRAS', submissionDate: '2026-07-24', activityPhase: '' },
    columns,
  ), true)
})
