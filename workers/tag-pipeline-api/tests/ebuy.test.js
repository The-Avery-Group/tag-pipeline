import assert from 'node:assert/strict'
import test from 'node:test'
import { EBUY_FIXTURE_OPPORTUNITIES } from '../src/fixtures/ebuyOpportunities.js'
import { hashEbuyOpportunity, lifecycleForEbuyOpportunity, normalizeEbuyOpportunity, retentionDeadline } from '../src/lib/ebuyDomain.js'
import { syncEbuyOpportunities } from '../src/lib/ebuyRepository.js'

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
    if (this.sql.includes('FROM ebuy_opportunities WHERE request_id')) return null
    return null
  }
  async all() { return { results: [] } }
  async run() { this.db.executed.push(this); return { success: true } }
}

class PlaceholderCheckingD1 {
  constructor() { this.executed = [] }
  prepare(sql) { return new PlaceholderCheckingStatement(sql, this) }
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
