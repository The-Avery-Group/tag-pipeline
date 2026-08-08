import assert from 'node:assert/strict'
import test from 'node:test'
import {
  isRfiWorkflowNoticeType,
  isRfiWorkflowOpportunity,
  isResponseOpportunity,
  isSubmittedOpportunity,
  normalizeNoticeType,
  submittedOpportunityNoticeType,
} from '../src/utils/noticeTypes.js'

test('normalizes supported notice types and market research aliases', () => {
  assert.equal(normalizeNoticeType('market research'), 'MRAS')
  assert.equal(normalizeNoticeType('Sources Sought'), 'RFI')
  assert.equal(normalizeNoticeType('Combined Synopsis/Solicitation'), 'RFQ')
  assert.equal(normalizeNoticeType('unknown'), '')
})

test('MRAS and RFI use the same workflow', () => {
  assert.equal(isRfiWorkflowNoticeType('RFI'), true)
  assert.equal(isRfiWorkflowNoticeType('MRAS'), true)
  assert.equal(isRfiWorkflowNoticeType('RFP'), false)
  assert.equal(isRfiWorkflowOpportunity({ 'Notice Type': 'MRAS' }), true)
})

test('legacy submitted RFI records remain in the workflow when Notice Type is blank', () => {
  assert.equal(isRfiWorkflowOpportunity({ 'TAG Pipeline Activity Phase': 'Submitted RFI' }), true)
  assert.equal(isRfiWorkflowOpportunity({ 'TAG Opportunity Phase': 'Identified', 'Opportunity Outlook': 'New' }), false)
})

test('Responses includes every supported notice type and legacy submitted phases', () => {
  for (const noticeType of ['RFI', 'MRAS', 'RFP', 'RFQ']) {
    assert.equal(isResponseOpportunity({ 'Notice Type': noticeType }), true)
  }
  assert.equal(isResponseOpportunity({ 'TAG Pipeline Activity Phase': 'Submitted Market Research' }), true)
  assert.equal(isResponseOpportunity({ 'TAG Pipeline Activity Phase': 'Submitted RFP' }), true)
  assert.equal(isResponseOpportunity({ 'TAG Pipeline Activity Phase': 'Submitted RFQ' }), true)
  assert.equal(isResponseOpportunity({ 'TAG Opportunity Phase': 'Identified' }), false)
})

test('submission state comes from activity phase and notice type labels the submission', () => {
  const opportunity = {
    'Notice Type': 'RFP',
    'TAG Pipeline Activity Phase': 'Submitted RFP',
  }
  assert.equal(isSubmittedOpportunity(opportunity), true)
  assert.equal(submittedOpportunityNoticeType(opportunity), 'RFP')
  assert.equal(isSubmittedOpportunity({ 'Notice Type': 'RFI' }), false)
  assert.equal(submittedOpportunityNoticeType({
    'TAG Pipeline Activity Phase': 'Submitted Market Research',
  }), 'MRAS')
})
