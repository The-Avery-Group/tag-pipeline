import assert from 'node:assert/strict'
import test from 'node:test'
import { isFollowOnSourceOpportunity, isRfiWorkflowOpportunity, isTrackedOpportunity } from '../src/lib/noticeTypes.js'

test('tracked pipeline discoveries do not enter scheduled response workflows', () => {
  const opportunity = { 'Notice Type': 'RFI', 'Opportunity Outlook': 'Tracking' }
  assert.equal(isTrackedOpportunity(opportunity), true)
  assert.equal(isRfiWorkflowOpportunity(opportunity), false)
  assert.equal(isFollowOnSourceOpportunity(opportunity), false)
})

test('non-tracked response records remain eligible', () => {
  const opportunity = { 'Notice Type': 'MRAS', 'Opportunity Outlook': 'New' }
  assert.equal(isRfiWorkflowOpportunity(opportunity), true)
  assert.equal(isFollowOnSourceOpportunity(opportunity), true)
})
