import test from 'node:test'
import assert from 'node:assert/strict'
import { needsRfiActivityPhasePrompt, AWARD_FIELDS, awardInformationPatch } from '../src/utils/opportunityFormRules.js'

test('award details are optional and never patch original solicitation fields', () => {
  const patch = awardInformationPatch({ 'Solicitation Number': 'do-not-overwrite', 'Award Amount': 0 })
  assert.equal(patch['Award Amount'], 0)
  assert.equal(patch['Award Signed Date'], '')
  assert.equal(patch['Solicitation Number'], undefined)
  assert.deepEqual(Object.keys(patch), AWARD_FIELDS.map(([column]) => column))
  assert.equal(Object.values(awardInformationPatch({})).every((value) => value === ''), true)
})

test('award details validate dates, amounts, and safe notice links', () => {
  assert.throws(() => awardInformationPatch({ 'Award Amount': '-1' }))
  assert.throws(() => awardInformationPatch({ 'Award Signed Date': '2026-02-30' }))
  assert.throws(() => awardInformationPatch({ 'Award Performance Start': '2026-09-05', 'Award Performance End': '2026-01-01' }))
  assert.throws(() => awardInformationPatch({ 'Award Notice Link': 'javascript:alert(1)' }))
  assert.equal(awardInformationPatch({ 'Award Amount': '12500.25', 'Award Notice Link': 'https://sam.gov/' })['Award Amount'], 12500.25)
})

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
