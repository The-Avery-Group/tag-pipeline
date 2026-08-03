import assert from 'node:assert/strict'
import test from 'node:test'
import {
  isRfiWorkflowNoticeType,
  isRfiWorkflowOpportunity,
  normalizeNoticeType,
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
