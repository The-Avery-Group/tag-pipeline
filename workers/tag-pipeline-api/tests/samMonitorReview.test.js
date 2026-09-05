import assert from 'node:assert/strict'
import test from 'node:test'

import { preserveSAMChangeReview, portalFilesNeedingRefresh, checkPortalFiles } from '../src/handlers/samMonitor.js'
import { portalAttachmentsFromHtml, stablePortalSourceSignature, portalFileIdentity } from '../src/lib/opportunityWorkspaceSam.js'

test('portal monitoring skips saved files and finds additions and failed downloads', () => {
  const sources = portalAttachmentsFromHtml('https://piee.eb.mil/sol/xhtml/unauth/search/oppMgmtLink.xhtml?noticeId=123',
    '<a id="a">PWS.pdf</a><a id="b">Amendment.pdf</a>')
  const saved = [{ source_url: sources[0], archive_status: 'archived', sharepoint_item_id: 'file1' }]
  assert.deepEqual(portalFilesNeedingRefresh(sources, saved), [sources[1]])
  assert.deepEqual(portalFilesNeedingRefresh([sources[0]], saved), [])
  saved[0].archive_status = 'failed'
  assert.deepEqual(portalFilesNeedingRefresh([sources[0]], saved), [sources[0]])
  assert.deepEqual(portalFilesNeedingRefresh([], saved), [])
})

test('explicit portal revision metadata triggers retrieval without reading document content', () => {
  const portal = 'https://piee.eb.mil/sol/xhtml/unauth/search/oppMgmtLink.xhtml?noticeId=123'
  const [before] = portalAttachmentsFromHtml(portal, '<a id="a" data-version="1">PWS.pdf</a>')
  const [after] = portalAttachmentsFromHtml(portal, '<a id="a" data-version="2">PWS.pdf</a>')
  assert.notEqual(stablePortalSourceSignature(before), stablePortalSourceSignature(after))
  assert.equal(portalFileIdentity(before), portalFileIdentity(after), 'revisions retain the same destination identity')
  assert.deepEqual(portalFilesNeedingRefresh([after], [{ source_url: before, archive_status: 'archived', sharepoint_item_id: 'f' }]), [after])
})

test('portal discovery errors never become file downloads', () => {
  const issue = 'https://www.fedconnect.net/FedConnect/?doc=123#tag-portal-issue=' + encodeURIComponent('provider=fedconnect&message=Unavailable')
  assert.deepEqual(portalFilesNeedingRefresh([issue, 'https://example.com/file.pdf'], []), [])
})

test('portal checks reuse manifests and queue changes even without a SAM revision', async () => {
  const portal = 'https://piee.eb.mil/sol/xhtml/unauth/search/oppMgmtLink.xhtml?noticeId=123'
  const sources = portalAttachmentsFromHtml(portal, '<a id="a">PWS.pdf</a>')
  const manifests = new Map([[portal, sources]])
  const requests = []
  let saved = []
  let busy = false
  const env = {
    EBUY_DB: { prepare() { return {
      bind() { return this },
      async first() { return { opportunity_key: 'test', root_folder_id: 'folder' } },
      async all() { return { results: saved } },
      async run() { return { meta: { changes: busy ? 0 : 1 } } },
    } } },
    OPPORTUNITY_WORKSPACE_WORKFLOW: { async createBatch(batch) { requests.push(...batch); return batch } },
  }
  // No notice ID avoids a SAM resources request; the supplied public link is sufficient.
  const record = { additionalInfoLink: portal }
  const watch = { solicitationNumber: 'test' }
  await checkPortalFiles(env, watch, record, manifests)
  assert.equal(requests.length, 1)
  assert.equal(requests[0].params.portalOnly, true)
  assert.equal(requests[0].params.syncAttachments, true)
  assert.equal(watch.attachmentSyncRevision, undefined)
  busy = true
  await checkPortalFiles(env, watch, record, manifests)
  assert.equal(requests.length, 1, 'active workflow must not be duplicated')
  busy = false
  saved = [{ source_url: sources[0], archive_status: 'archived', sharepoint_item_id: 'f' }]
  await checkPortalFiles(env, watch, record, manifests)
  assert.equal(requests.length, 1, 'unchanged saved files do not start another workflow')
})

test('an acknowledged SAM change remains acknowledged when the same revision is seen again', () => {
  const reviewedAt = '2027-01-02T12:00:00.000Z'
  const previous = {
    fields: ['title', 'responseDate'],
    sourceModifiedAt: '2027-01-01T12:00:00.000Z',
    reviewedAt,
  }
  const candidate = {
    fields: ['responseDate', 'title'],
    sourceModifiedAt: '2027-01-01T12:00:00.000Z',
  }
  assert.equal(preserveSAMChangeReview(previous, candidate, {}).reviewedAt, reviewedAt)
})

test('a genuinely new SAM revision is not pre-acknowledged', () => {
  const previous = {
    fields: ['title'],
    sourceModifiedAt: '2027-01-01T12:00:00.000Z',
    reviewedAt: '2027-01-02T12:00:00.000Z',
  }
  const candidate = {
    fields: ['title'],
    sourceModifiedAt: '2027-01-03T12:00:00.000Z',
  }
  assert.equal(preserveSAMChangeReview(previous, candidate, {}).reviewedAt, null)
})

test('an acknowledged SAM fingerprint remains durable even if source date formatting varies', () => {
  const snapshot = { title: 'Current title', modifiedDate: '2027-01-01T12:00:00Z' }
  const reviewed = preserveSAMChangeReview(null, {
    fields: ['title'],
    sourceModifiedAt: '2027-01-01T12:00:00Z',
  }, snapshot)
  reviewed.reviewedAt = '2027-01-02T12:00:00Z'
  reviewed.reviewedFingerprint = reviewed.fingerprint

  const repeated = preserveSAMChangeReview(reviewed, {
    fields: ['title'],
    sourceModifiedAt: 'January 1, 2027 12:00 UTC',
  }, snapshot)
  assert.equal(repeated.reviewedAt, reviewed.reviewedAt)
  assert.equal(repeated.reviewedFingerprint, reviewed.fingerprint)
})
