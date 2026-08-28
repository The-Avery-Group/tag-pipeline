import assert from 'node:assert/strict'
import test from 'node:test'
import { EBUY_FIXTURE_OPPORTUNITIES } from '../src/fixtures/ebuyOpportunities.js'
import { changedEbuyFields, hashEbuyOpportunity, lifecycleForEbuyOpportunity, normalizeEbuyOpportunity, retentionDeadline } from '../src/lib/ebuyDomain.js'
import { normalizeLiveEbuyOpportunity } from '../src/lib/ebuyClient.js'
import { decryptEbuySecret, encryptEbuySecret, maskEbuyUsername } from '../src/lib/ebuyCrypto.js'
import { generateTotp } from '../src/lib/ebuyTotp.js'
import {
  deleteEbuyFixtureRecords,
  isEbuySyncRunStale,
  reconcileEbuyPipelineRecords,
  recoverStaleEbuySyncRuns,
  recordArchivedEbuyAttachment,
  stageEbuySyncCandidates,
  syncEbuyOpportunities,
  unlinkEbuyPipelineRecord,
} from '../src/lib/ebuyRepository.js'

class SyncRunStatement {
  constructor(sql, db) { this.sql = sql; this.db = db; this.values = [] }
  bind(...values) { this.values = values; return this }
  async all() { return { results: this.db.rows } }
  async run() {
    this.db.updates.push({ sql: this.sql, values: this.values })
    return { success: true, meta: { changes: 1 } }
  }
}

class SyncRunD1 {
  constructor(rows = []) { this.rows = rows; this.updates = [] }
  prepare(sql) { return new SyncRunStatement(sql, this) }
}

class PlaceholderCheckingStatement {
  constructor(sql, db) { this.sql = sql; this.db = db; this.values = [] }
  bind(...values) {
    const placeholders = (this.sql.match(/\?/g) || []).length
    assert.equal(values.length, placeholders, `SQL binding mismatch in: ${this.sql.slice(0, 90)}`)
    this.values = values
    return this
  }
  async first() {
    if (this.sql.includes('FROM ebuy_settings')) return { dismissed_retention_days: 30, expired_retention_days: 90, unavailable_retention_days: 30 }
    if (this.sql.startsWith('SELECT request_id FROM ebuy_opportunities')) {
      return this.db.opportunities.has(this.values[0]) ? { request_id: this.values[0] } : null
    }
    if (this.sql.includes('FROM ebuy_opportunities WHERE request_id')) return null
    return null
  }
  async all() { return { results: [] } }
  async run() { this.db.executed.push(this); return { success: true } }
}

class PlaceholderCheckingD1 {
  constructor(opportunities = []) { this.executed = []; this.opportunities = new Set(opportunities) }
  prepare(sql) { return new PlaceholderCheckingStatement(sql, this) }
  async batch(statements) { for (const statement of statements) await statement.run(); return statements.map(() => ({ success: true })) }
}

class ReconciliationStatement {
  constructor(sql, db) { this.sql = sql; this.db = db; this.values = [] }
  bind(...values) { this.values = values; return this }
  async first() {
    if (this.sql.includes('FROM ebuy_settings')) return { dismissed_retention_days: 30, expired_retention_days: 90, unavailable_retention_days: 30 }
    if (this.sql.includes('FROM ebuy_opportunities') && this.sql.includes('LIMIT 1')) return this.db.match || null
    return null
  }
  async all() { return { results: this.db.rows } }
  async run() { this.db.executed.push(this); return { success: true } }
}

class ReconciliationD1 {
  constructor(rows = [], match = null) { this.rows = rows; this.match = match; this.executed = [] }
  prepare(sql) { return new ReconciliationStatement(sql, this) }
  async batch(statements) { for (const statement of statements) await statement.run(); return statements.map(() => ({ success: true })) }
}

test('sanitized eBuy fixtures preserve the expected discovery field shape', () => {
  assert.ok(EBUY_FIXTURE_OPPORTUNITIES.length >= 5)
  for (const record of EBUY_FIXTURE_OPPORTUNITIES) {
    assert.ok(record.requestId)
    assert.ok(record.title)
    assert.ok(record.buyerAgency)
    assert.ok(Array.isArray(record.vehiclePairs))
    assert.doesNotMatch(JSON.stringify(record), /g2xchange\.com|scopedKey|typesense-api-key/i)
  }
})

test('eBuy content hashing ignores source polling time but detects material changes', async () => {
  const source = EBUY_FIXTURE_OPPORTUNITIES[0]
  const first = await hashEbuyOpportunity({ ...source, lastScrapedAt: '2026-08-10T00:00:00Z' })
  const second = await hashEbuyOpportunity({ ...source, lastScrapedAt: '2026-08-11T00:00:00Z' })
  const changed = await hashEbuyOpportunity({ ...source, title: `${source.title} updated` })
  assert.equal(first, second)
  assert.notEqual(first, changed)
})

test('eBuy history ignores connector metadata and unordered source arrays', async () => {
  const source = EBUY_FIXTURE_OPPORTUNITIES[0]
  const first = await hashEbuyOpportunity({
    ...source,
    vehiclePairs: ['MAS:541611', 'MAS:54151S'],
    sourceDetails: { requestId: 'first-request', diagnostics: { elapsed: 10 } },
  })
  const second = await hashEbuyOpportunity({
    ...source,
    vehiclePairs: ['MAS:54151S', 'MAS:541611'],
    sourceDetails: { requestId: 'second-request', diagnostics: { elapsed: 999 } },
  })
  assert.equal(first, second)
  assert.deepEqual(changedEbuyFields(
    { ...source, sourceDetails: { connectorRun: 1 } },
    { ...source, sourceDetails: { connectorRun: 2 } },
  ), [])
})

test('eBuy history records real amendment changes but not attachment archive changes', () => {
  const source = EBUY_FIXTURE_OPPORTUNITIES[0]
  const amendment = { id: 'amendment-1', label: 'Amendment 1', description: 'Closing date changed', postedAt: '2026-08-12' }
  assert.deepEqual(changedEbuyFields(
    { ...source, amendments: [], attachments: [{ id: 'file-1', fileName: 'old.pdf' }] },
    { ...source, amendments: [amendment], attachments: [{ id: 'file-2', fileName: 'new.pdf' }] },
  ), ['amendments'])
})

test('protected eBuy records never receive an automatic purge date', () => {
  const now = new Date('2026-08-11T00:00:00Z')
  assert.equal(retentionDeadline('flagged', 'expired', now), null)
  assert.equal(retentionDeadline('tracked', 'unavailable', now), null)
  assert.equal(retentionDeadline('added_to_pipeline', 'expired', now), null)
  assert.equal(retentionDeadline('dismissed', 'active', now), '2026-09-10T00:00:00.000Z')
})

test('normalization and lifecycle use the eBuy close date', () => {
  const record = normalizeEbuyOpportunity(EBUY_FIXTURE_OPPORTUNITIES[0], '2026-08-11T00:00:00Z')
  assert.equal(record.buyerEmail, 'buyer.one@example.gov')
  assert.equal(lifecycleForEbuyOpportunity(record, new Date('2026-08-22T00:00:00Z')), 'expired')
})

test('fixture synchronization binds every D1 statement consistently', async () => {
  const db = new PlaceholderCheckingD1()
  const result = await syncEbuyOpportunities(db, EBUY_FIXTURE_OPPORTUNITIES, { source: 'fixture' })
  assert.equal(result.inserted, EBUY_FIXTURE_OPPORTUNITIES.length)
  assert.ok(db.executed.length > EBUY_FIXTURE_OPPORTUNITIES.length)
})

test('candidate staging refreshes the contract used to retrieve duplicate discovery records', async () => {
  const db = new PlaceholderCheckingD1()
  await stageEbuySyncCandidates(db, 'run-1', '47QRAA22D0001', [{ rfqId: 'RFQ123', title: 'First listing' }])
  assert.equal(db.executed.length, 1)
  assert.match(db.executed[0].sql, /contract_number = excluded\.contract_number/)
})

test('legacy demo cleanup targets only records carrying the sanitized fixture marker', async () => {
  const db = new PlaceholderCheckingD1()
  await deleteEbuyFixtureRecords(db)
  assert.equal(db.executed.length, 1)
  assert.match(db.executed[0].sql, /DELETE FROM ebuy_opportunities/)
  assert.match(db.executed[0].sql, /sanitized-g2x-schema/)
})

test('archived fixture attachments are saved as one idempotent D1 record', async () => {
  const db = new PlaceholderCheckingD1(['RFI-DEMO-001'])
  const attachment = await recordArchivedEbuyAttachment(db, {
    id: 'RFI-DEMO-001-archive-test',
    requestId: 'RFI-DEMO-001',
    fileName: 'TAG_eBuy_Archive_Test.txt',
    contentType: 'text/plain; charset=utf-8',
    byteSize: 128,
    sourceHash: 'fixture-hash',
    driveId: 'drive-id',
    itemId: 'item-id',
    webUrl: 'https://example.sharepoint.com/test-file',
  })

  assert.equal(attachment.archiveStatus, 'archived')
  assert.equal(attachment.sharepointItemId, 'item-id')
  assert.equal(db.executed.length, 1)
  assert.match(db.executed[0].sql, /ON CONFLICT\(id\) DO UPDATE/)
})

test('attachment archive requires the synchronized fixture opportunity', async () => {
  const db = new PlaceholderCheckingD1()
  await assert.rejects(() => recordArchivedEbuyAttachment(db, {
    id: 'missing', requestId: 'RFI-DEMO-001', fileName: 'missing.txt', contentType: 'text/plain',
    byteSize: 1, sourceHash: 'hash', driveId: 'drive', itemId: 'item', webUrl: 'https://example.com',
  }), /Synchronize the test eBuy archive/)
})

test('pipeline reconciliation repairs missing and stale eBuy pipeline markers', async () => {
  const db = new ReconciliationD1([
    { request_id: 'RFI-KEEP', review_state: 'new', lifecycle_status: 'active', pipeline_contract_id: null },
    { request_id: 'RFQ-REMOVE', review_state: 'added_to_pipeline', lifecycle_status: 'active', pipeline_contract_id: 'RFQ-REMOVE' },
  ])
  const result = await reconcileEbuyPipelineRecords(db, [{ id: 'RFI-KEEP', outlook: 'Tracking' }])
  assert.deepEqual(result, { linked: 1, unlinked: 1, changed: 2 })
  assert.equal(db.executed[0].values[0], 'tracked')
  assert.equal(db.executed[0].values[1], 'RFI-KEEP')
  assert.equal(db.executed[1].values[0], 'new')
})

test('pipeline deletion immediately clears the eBuy link', async () => {
  const db = new ReconciliationD1([], {
    request_id: 'RFI-DELETE', review_state: 'added_to_pipeline', lifecycle_status: 'active',
  })
  const result = await unlinkEbuyPipelineRecord(db, 'RFI-DELETE')
  assert.deepEqual(result, { changed: 1, requestId: 'RFI-DELETE', reviewState: 'new' })
  assert.equal(db.executed.length, 1)
  assert.equal(db.executed[0].values[0], 'new')
})

test('eBuy secrets use authenticated encryption and never expose plaintext', async () => {
  const key = Buffer.alloc(32, 7).toString('base64')
  const source = { username: 'seller@example.com', password: 'not-a-real-password', totpSecret: 'JBSWY3DPEHPK3PXP' }
  const encrypted = await encryptEbuySecret(key, source)
  assert.doesNotMatch(encrypted, /seller@example\.com|not-a-real-password|JBSWY3DPEHPK3PXP/)
  assert.deepEqual(await decryptEbuySecret(key, encrypted), source)
  assert.equal(maskEbuyUsername('seller@example.com'), 'se****@example.com')
})

test('TOTP generation follows the standard HMAC-SHA1 test vector', async () => {
  const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'
  assert.equal(await generateTotp(secret, 59_000, { digits: 8 }), '94287082')
})

test('live eBuy details normalize into the archive field model', () => {
  const record = normalizeLiveEbuyOpportunity({
    rfqId: 'RFI123', title: 'Program support', userAgency: 'Agency', issueTime: 1_786_000_000_000,
  }, {
    rfqInfo: { rfqId: 'RFI123', title: 'Program support', description: 'Scope', sourceSought: true, issueTime: 1_786_000_000_000, closeTime: 1_786_086_400_000 },
    rfqProps: { userAgency: 'Agency', userBureau: 'Office', userName: 'Buyer', userEmail: 'BUYER@EXAMPLE.GOV' },
    rfqAdditionalInfo: { contractType: 'T&M', awardMethod: 'Best value' },
    rfqCategories: [{ schedule: 'MAS', sin: '541611' }],
    rfqAttachments: [{ docName: 'Scope.pdf', docPath: '/files/scope.pdf', docSeqNum: 4 }],
    rfqModifications: [{ versionNumber: 2, modificationNote: 'Updated date', modificationTime: 1_786_010_000_000 }],
  }, '47QRAA22D00A0')
  assert.equal(record.requestType, 'RFI')
  assert.equal(record.buyerAgency, 'Office')
  assert.equal(record.buyerDepartment, 'Agency')
  assert.deepEqual(record.vehiclePairs, ['MAS:541611'])
  assert.equal(record.attachments[0].id, 'RFI123:4')
  assert.equal(record.amendments[0].label, 'Modification 2')
})

test('wrapped eBuy details retain descriptive set-asides and discover nested attachments', () => {
  const record = normalizeLiveEbuyOpportunity({
    rfqId: 'RFQ1842000',
    title: 'Summary title',
    setAsideType: 'SB',
  }, {
    rfq: {
      rfqInfo: { rfqId: 'RFQ1842000', description: 'Use the attached statement of work.' },
      rfqProps: { setAsideBusinessIndicator: true, userAgency: 'Department', userBureau: 'Agency' },
      rfqAdditionalInfo: { setAsideDescription: '8(a) Competitive', ocoEmail: 'buyer@example.gov' },
      responseDocuments: {
        files: [{ originalFileName: 'Statement of Work.pdf', filePath: '/ebuy_upload/RFQ1842000/sow.pdf' }],
      },
    },
  }, 'MAS')

  assert.equal(record.title, 'Summary title')
  assert.equal(record.setAsideType, '8(a) Set-Aside')
  assert.equal(record.buyerEmail, 'buyer@example.gov')
  assert.deepEqual(record.attachments.map((item) => item.fileName), ['Statement of Work.pdf'])
})

test('stale eBuy synchronization runs are detected and changed into resumable errors', async () => {
  const now = new Date('2026-08-28T12:00:00.000Z')
  const row = {
    id: 'sync-stale',
    status: 'running',
    started_at: '2026-08-27T12:00:00.000Z',
    details_json: JSON.stringify({
      progress: { phase: 'archiving', percent: 57, updatedAt: '2026-08-27T12:10:00.000Z' },
    }),
  }
  assert.equal(isEbuySyncRunStale(row, now.getTime()), true)

  const db = new SyncRunD1([row])
  const result = await recoverStaleEbuySyncRuns(db, { now })
  assert.deepEqual(result, { recovered: 1 })
  assert.equal(db.updates.length, 1)
  assert.equal(db.updates[0].values[3], 'sync-stale')
  assert.match(db.updates[0].values[1], /stopped reporting progress/i)
  assert.equal(JSON.parse(db.updates[0].values[2]).progress.percent, 57)
})

test('live eBuy normalization preserves the MRAS classification over an RFI request ID', () => {
  const record = normalizeLiveEbuyOpportunity({
    rfqId: 'RFI7654321', title: 'Market Research as a Service for program support',
  }, {
    rfqInfo: {
      rfqId: 'RFI7654321', title: 'Market Research as a Service for program support',
      requestTypeString: 'RFI',
    },
  }, '47QRAA22D0001')
  assert.equal(record.requestType, 'MRAS')
})

test('live eBuy normalization discovers amendment and description-linked files and reports missing references', () => {
  const record = normalizeLiveEbuyOpportunity({ rfqId: 'RFI900' }, {
    rfqInfo: {
      rfqId: 'RFI900',
      title: 'Attachment coverage',
      description: 'See attached Pricing Template.xlsx and <a href="/ebuy_upload/202608/RFI900/Scope.pdf">Scope</a>.',
    },
    rfqModifications: [{
      versionNumber: 2,
      attachments: [{ fileName: 'Amendment 2.docx', url: '/ebuy_upload/202608/RFI900/Amendment-2.docx' }],
    }],
  }, 'MAS-1')

  assert.deepEqual(record.attachments.map((attachment) => attachment.fileName).sort(), ['Amendment 2.docx', 'Scope.pdf'])
  assert.equal(record.attachments.find((attachment) => attachment.fileName === 'Amendment 2.docx').amendmentId, '2')
  assert.equal(record.attachmentReferences.mentioned, true)
  assert.deepEqual(record.attachmentReferences.missing, ['Pricing Template.xlsx'])
})

test('an eBuy discovery summary remains usable when its detail request is temporarily unavailable', () => {
  const summary = {
    rfqId: 'RFQ1830432',
    title: 'Discovery title',
    userAgency: 'Department of Example',
    userName: 'Casey Buyer',
    userEmail: 'casey@example.gov',
    issueTime: 1_786_000_000_000,
    rfq: {
      rfqInfo: {
        rfqId: 'RFQ1830432',
        title: 'Discovery title',
        description: 'The complete description returned by active eBuy discovery.',
        requestType: 1,
        issueTime: 1_786_000_000_000,
        closeTime: 1_786_086_400_000,
      },
      rfqAdditionalInfo: { contractType: 'Firm fixed price' },
      rfqProps: {},
    },
  }
  const record = normalizeLiveEbuyOpportunity(summary, summary.rfq, '47QRAA22D0001')
  assert.equal(record.requestId, 'RFQ1830432')
  assert.equal(record.requestType, 'RFQ')
  assert.equal(record.title, 'Discovery title')
  assert.equal(record.description, 'The complete description returned by active eBuy discovery.')
  assert.equal(record.buyerAgency, 'Department of Example')
  assert.equal(record.buyerName, 'Casey Buyer')
})
