import test from 'node:test'
import assert from 'node:assert/strict'
import { agencyEvidence, partnerEnrichmentPeriod, vehicleRecord, startPartnerEnrichment, savePartnerSummary } from '../src/lib/partnerEnrichment.js'
const uei = 'ABCDEFGHIJK1'

test('uses a rolling five-year period', () => {
  assert.deepEqual(partnerEnrichmentPeriod('2026-09-15T12:00:00Z'), { start_date: '2021-09-15', end_date: '2026-09-15' })
})
test('funding agency takes precedence and exact recipient UEI is required', () => {
  const row = { 'Recipient UEI': uei, 'Funding Sub Agency': 'CDC', 'Awarding Agency': 'GSA', generated_internal_id: 'award1' }
  const result = agencyEvidence([row, row], uei)
  assert.equal(result.length, 1)
  assert.equal(result[0].name, 'CDC')
  assert.equal(result[0].source, 'funding')
  assert.throws(() => agencyEvidence([{ ...row, 'Recipient UEI': 'DIFFERENT123' }], uei), /identity/)
})
test('awarding agency fallback retains its evidence role', () => {
  assert.equal(agencyEvidence([{ 'Recipient UEI': uei, 'Awarding Agency': 'GSA' }], uei)[0].source, 'awarding')
})
test('only the entity own IDV supplies vehicle dates, not a delivery order', () => {
  const detail = { category: 'idv', piid: 'TEST123', generated_unique_award_id: 'CONT_IDV_TEST123', recipient: { recipient_uei: uei }, period_of_performance: { end_date: '2027-01-01', potential_end_date: '2030-01-01' } }
  const record = vehicleRecord(detail, uei, [], '2026-09-15')
  assert.equal(record['Current End Date'], '2027-01-01')
  assert.equal(record['Potential End Date'], '2030-01-01')
  assert.equal(record['Vehicle Name'], '')
  assert.throws(() => vehicleRecord({ ...detail, category: 'contract' }, uei, [], ''), /parent vehicle/)
  assert.throws(() => vehicleRecord(detail, 'OTHERUEI1234', [], ''), /recipient differs/)
})
test('missing database/workflow bindings fail closed without KV writes', async () => {
  await assert.rejects(startPartnerEnrichment({ CACHE: { put() { throw new Error('must not write KV') } } }), /bindings/)
})

test('summary publishing patches only machine-owned cells and preserves user columns', async () => {
  const originalFetch = globalThis.fetch
  const columns = ['UEI Number', 'USAspending Enabled', 'Notes', 'USAspending Agencies', 'USAspending Refreshed At']
  const writes = []
  globalThis.fetch = async (url, options = {}) => {
    const path = String(url)
    if (path.includes('oauth2')) return Response.json({ access_token: 'test-token', expires_in: 3600 })
    if (options.method === 'PATCH') { writes.push({ path, body: JSON.parse(options.body) }); return Response.json({}) }
    if (path.endsWith('/columns')) return Response.json({ value: columns.map(name => ({ name })) })
    if (path.includes('/rows?')) return Response.json({ value: [{ index: 2, values: [[uei, 'Yes', 'Important internal note', 'Old agency', '']] }] })
    if (path.endsWith('/worksheet')) return Response.json({ id: 'sheet1' })
    if (path.endsWith('/range')) return Response.json({ rowIndex: 4, columnIndex: 1 })
    throw new Error(`Unexpected request ${path}`)
  }
  try {
    const env = { MS_TENANT_ID: 'test', MS_CLIENT_ID: 'test', MS_CLIENT_SECRET: 'test', WORKBOOK_ID: 'test' }
    await savePartnerSummary(env, uei, { 'USAspending Agencies': 'CDC' })
    assert.equal(writes.length, 1)
    assert.match(writes[0].path, /range\(address='E8'\)/)
    assert.deepEqual(writes[0].body, { values: [['CDC']] })
    await assert.rejects(savePartnerSummary(env, uei, { Notes: 'overwrite' }), /Unsafe/)
    assert.equal(writes.length, 1)
  } finally { globalThis.fetch = originalFetch }
})
