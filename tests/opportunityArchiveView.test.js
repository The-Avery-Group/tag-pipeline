import test from 'node:test'
import assert from 'node:assert/strict'
import { OPPORTUNITY_PRIMARY_TABS, resolveOpportunityListView } from '../src/utils/opportunityArchiveView.js'

test('archive is not exposed as a primary opportunity tab', () => {
  assert.deepEqual(OPPORTUNITY_PRIMARY_TABS, ['All', 'Responses', 'Expiring', 'Tracked', 'New'])
})

test('archived opportunities are hidden unless explicitly requested', () => {
  assert.deepEqual(resolveOpportunityListView(new URLSearchParams('tab=All')), { activeTab: 'All', showArchived: false })
  assert.deepEqual(resolveOpportunityListView(new URLSearchParams('tab=All&archived=1')), { activeTab: 'All', showArchived: true })
})

test('legacy Archive links open the hidden archived view without restoring the tab', () => {
  assert.deepEqual(resolveOpportunityListView(new URLSearchParams('tab=Archive')), { activeTab: 'All', showArchived: true })
})

test('stale archived state cannot replace New opportunity discovery', () => {
  assert.deepEqual(resolveOpportunityListView(new URLSearchParams('tab=New&archived=1')), { activeTab: 'New', showArchived: false })
})
