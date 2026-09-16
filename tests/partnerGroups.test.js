import test from 'node:test'
import assert from 'node:assert/strict'
import { groupPartners, sharedPartnerWorkspace, partnerProfilePath, partnerRefreshEnabled, partnerRefreshDue, createPartnerRefreshQueue } from '../src/utils/partnerGroups.js'
import { fetchPartnerAwardEvidence } from '../src/services/usaSpendingService.js'
import { readFileSync } from 'node:fs'

test('shared queue keeps only one partner running, deduplicates clicks and survives page unsubscribe', async () => {
  const queue = createPartnerRefreshQueue()
  let release; const gate = new Promise(resolve => { release = resolve })
  let firstCalls = 0; let secondCalls = 0; let events = 0
  const unsubscribe = queue.subscribe(() => { events++ })
  const first = queue.enqueue('GLGMWJ8EVMR9', 'Liberty', async progress => {
    firstCalls++; progress('Saving to workbook…'); await gate; return { saved: true }
  })
  const second = queue.enqueue('ABCDEFGHIJKL', 'Second partner', async () => { secondCalls++; return { saved: true } })
  assert.equal(queue.enqueue('glgmwj8evmr9', 'Liberty', () => { throw new Error('Duplicate') }), first)
  await Promise.resolve()
  assert.deepEqual(queue.getSnapshot().map(job => [job.uei, job.status]), [['GLGMWJ8EVMR9', 'running'], ['ABCDEFGHIJKL', 'queued']])
  assert.equal(secondCalls, 0)
  unsubscribe()
  const before = events
  release()
  await Promise.all([first, second])
  assert.equal(events, before)
  assert.equal(firstCalls, 1)
  assert.equal(secondCalls, 1)
  assert.deepEqual(queue.getSnapshot().map(job => job.status), ['complete', 'complete'])
})

test('failed partner does not block the queue and can be explicitly retried', async () => {
  const queue = createPartnerRefreshQueue()
  const failed = queue.enqueue('GLGMWJ8EVMR9', 'Liberty', async () => { throw new Error('Network failed') })
  const next = queue.enqueue('ABCDEFGHIJKL', 'Next', async () => ({ saved: true }))
  await assert.rejects(failed, /Network failed/)
  await next
  assert.deepEqual(queue.getSnapshot().map(job => job.status), ['failed', 'complete'])
  await queue.enqueue('GLGMWJ8EVMR9', 'Liberty', async () => ({ saved: true }))
  assert.equal(queue.getSnapshot()[0].error, '')
  assert.equal(queue.getSnapshot()[0].status, 'complete')
  queue.clearFinished()
  assert.deepEqual(queue.getSnapshot(), [])
})

test('clearing finished queue results retains active and queued partners', async () => {
  const queue = createPartnerRefreshQueue()
  let release; const gate = new Promise(resolve => { release = resolve })
  await queue.enqueue('FINISHED1234', 'Finished', async () => ({}))
  const first = queue.enqueue('GLGMWJ8EVMR9', 'Liberty', async () => gate)
  const second = queue.enqueue('ABCDEFGHIJKL', 'Next', async () => ({ skipped: true }))
  await Promise.resolve()
  queue.clearFinished()
  assert.deepEqual(queue.getSnapshot().map(job => job.status), ['running', 'queued'])
  release()
  await Promise.all([first, second])
  assert.equal(queue.getSnapshot()[1].status, 'skipped')
})

// Exercise the existing Graph persistence functions with a workbook double,
// without importing the browser-only MSAL configuration into Node.
function workbookResearchHarness({ disabled = false, failVehicle = false, uncertainAppend = false } = {}) {
  const source = readFileSync(new URL('../src/services/graphService.js', import.meta.url), 'utf8')
  const section = source.slice(source.indexOf("const PARTNER_VEHICLE_TABLE ="), source.indexOf('async function partnerSchema()')).replaceAll('export async function', 'async function')
  const writes = []
  let rows = []; let reads = 0
  const partner = { 'UEI Number': 'GLGMWJ8EVMR9', 'USAspending Enabled': disabled ? 'No' : '', Notes: 'Keep research', _rowIndex: 2 }
  const headers = ['Record ID', 'Partner UEI', 'Vehicle Name', 'PIID', 'Relationship', 'Current End Date', 'Potential End Date', 'Last Date to Order', 'Source Link', 'Last Seen', 'Status']
  const dependencies = {
    invalidate: () => {}, getPartners: async () => [partner], getSheetRows: async () => { reads++; return rows },
    isMissingWorkbookTable: () => false, ensureTableColumns: async () => ({ headers: ['USAspending Agencies', 'USAspending Vehicles', 'USAspending Refreshed At'] }), PARTNER_ENRICHMENT_HEADERS: [],
    normalizeTableHeader: value => value, partnerValuesForWorkbook: value => value,
    queueTableMutation: async (_table, fn) => fn(), getTableHeaders: async () => headers,
    graphFetch: async (path, options) => {
      assert.equal(path, '/tables/PartnerVehiclesTable/rows/add')
      if (failVehicle) throw new Error('Workbook unavailable')
      const values = JSON.parse(options.body).values
      writes.push({ vehicle: values })
      rows = values.map(values => Object.fromEntries(headers.map((header, index) => [header, values[index]])))
      if (uncertainAppend) throw new Error('Response lost after save')
    },
    updateRowUnlocked: async () => { throw new Error('Unexpected row update') },
    appendWithReconciliation: async ({ append }) => append(),
    appendRow: async (_table, vehicle) => { if (failVehicle) throw new Error('Workbook unavailable'); writes.push({ vehicle }) },
    updateRow: async (_table, _index, patch) => writes.push({ patch }),
  }
  const api = new Function(...Object.keys(dependencies), `${section}; return { getPartnerResearch, savePartnerResearch }`)(...Object.values(dependencies))
  return { ...api, writes, partner, reads: () => reads }
}

test('multiple new vehicles use one batch write and one vehicle table read', async () => {
  const workbook = workbookResearchHarness()
  await workbook.savePartnerResearch({ uei: 'GLGMWJ8EVMR9', checkedAt: '2026-09-16T12:00:00Z', agencies: [], vehicles: Array.from({ length: 4 }, (_, index) => ({ 'Record ID': `IDV${index}`, PIID: `PIID${index}` })) })
  assert.equal(workbook.reads(), 1)
  assert.equal(workbook.writes.filter(write => write.vehicle).length, 1)
  assert.equal(workbook.writes[0].vehicle.length, 4)
})

test('uncertain batch append is reconciled without appending duplicates', async () => {
  const workbook = workbookResearchHarness({ uncertainAppend: true })
  await workbook.savePartnerResearch({ uei: 'GLGMWJ8EVMR9', checkedAt: '2026-09-16T12:00:00Z', agencies: [], vehicles: [{ 'Record ID': 'IDV1', PIID: 'PIID1' }, { 'Record ID': 'IDV2', PIID: 'PIID2' }] })
  assert.equal(workbook.writes.filter(write => write.vehicle).length, 1)
  assert.equal(workbook.reads(), 2)
  assert.ok(workbook.writes[1].patch)
})

test('workbook publication writes vehicles before only the machine-owned summary fields', async () => {
  const workbook = workbookResearchHarness()
  await workbook.savePartnerResearch({ uei: 'GLGMWJ8EVMR9', checkedAt: '2026-09-16T12:00:00Z', agencies: [{ name: 'VA' }], vehicles: [{ 'Record ID': 'GLGMWJ8EVMR9:IDV', 'Vehicle Name': 'GSA MAS', PIID: 'GS35F474CA' }] })
  assert.ok(workbook.writes[0].vehicle)
  assert.deepEqual(Object.keys(workbook.writes[1].patch).sort(), ['USAspending Agencies', 'USAspending Refreshed At', 'USAspending Vehicles'])
  assert.equal(workbook.partner.Notes, 'Keep research')
})

test('workbook opt-out or interrupted vehicle saving does not advance the successful refresh timestamp', async () => {
  const snapshot = { uei: 'GLGMWJ8EVMR9', checkedAt: '2026-09-16T12:00:00Z', agencies: [], vehicles: [{ 'Record ID': 'GLGMWJ8EVMR9:IDV', PIID: 'GS35F474CA' }] }
  const disabled = workbookResearchHarness({ disabled: true })
  await assert.rejects(disabled.savePartnerResearch(snapshot), /turned off/)
  assert.deepEqual(disabled.writes, [])
  const failed = workbookResearchHarness({ failVehicle: true })
  await assert.rejects(failed.savePartnerResearch(snapshot), /Workbook unavailable/)
  assert.deepEqual(failed.writes, [])
})

test('quarterly eligibility uses the workbook timestamp, valid UEI and explicit opt-out', () => {
  const partner = { 'UEI Number': 'GLGMWJ8EVMR9', 'USAspending Refreshed At': '2026-06-30T23:59:59Z' }
  const now = new Date('2026-09-16T12:00:00Z')
  assert.equal(partnerRefreshDue(partner, now), true)
  assert.equal(partnerRefreshDue({ ...partner, 'USAspending Refreshed At': '2026-07-01T00:00:00Z' }, now), false)
  assert.equal(partnerRefreshDue({ ...partner, 'USAspending Enabled': 'No' }, now), false)
  assert.equal(partnerRefreshDue({ ...partner, 'UEI Number': 'invalid' }, now), false)
  assert.equal(partnerRefreshDue({ ...partner, 'USAspending Refreshed At': '' }, now), true)
})

test('direct partner fetch follows every page, exact UEI and direct IDV details without caching', async t => {
  const uei = 'GLGMWJ8EVMR9'; const calls = []
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.ok(url.startsWith('https://api.usaspending.gov/api/v2/'))
    assert.ok(options.signal)
    const body = options.body ? JSON.parse(options.body) : null
    calls.push({ url, body, method: options.method })
    if (!body) return Response.json({ category: 'idv', piid: 'GS35F474CA', generated_unique_award_id: 'IDV_TEST', recipient: { recipient_uei: uei } })
    const contracts = body.filters.award_type_codes.includes('A')
    return Response.json({ results: [{ 'Recipient UEI': uei, 'Funding Sub Agency': contracts ? `Agency ${body.page}` : 'Not contract experience', generated_internal_id: contracts ? `CONTRACT_${body.page}` : 'IDV_TEST' }], page_metadata: { hasNext: contracts && body.page === 1 } })
  })
  const result = await fetchPartnerAwardEvidence(uei, { at: '2026-09-16T00:00:00Z' })
  assert.deepEqual(result.agencies.map(a => a.name), ['Agency 1', 'Agency 2'])
  assert.equal(result.details.length, 1)
  assert.equal(calls.length, 4)
  assert.equal(calls[3].method, 'GET')
  assert.deepEqual(calls[0].body.filters.time_period, [{ start_date: '2021-09-16', end_date: '2026-09-16' }])
  assert.equal(calls[2].body.filters.time_period, undefined)
})

test('direct partner fetch rejects wrong recipients and incomplete pages', async t => {
  const mock = t.mock.method(globalThis, 'fetch', async () => Response.json({ results: [{ 'Recipient UEI': 'WRONG0000000' }], page_metadata: { hasNext: false } }))
  await assert.rejects(fetchPartnerAwardEvidence('GLGMWJ8EVMR9'), /recipient does not match/)
  mock.mock.mockImplementation(async () => Response.json({ results: [] }))
  await assert.rejects(fetchPartnerAwardEvidence('GLGMWJ8EVMR9'), /incomplete page/)
})

test('direct partner fetch retries a 525 without a Worker proxy', async t => {
  let count = 0
  t.mock.method(globalThis, 'fetch', async url => {
    assert.ok(url.startsWith('https://api.usaspending.gov/'))
    count++
    return count === 1 ? new Response('', { status: 525 }) : Response.json({ results: [], page_metadata: { hasNext: false } })
  })
  const result = await fetchPartnerAwardEvidence('GLGMWJ8EVMR9')
  assert.equal(count, 3)
  assert.deepEqual(result.details, [])
})

test('direct partner fetch does not start after cancellation or accept a task order as an IDV', async t => {
  let calls = 0
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    calls++
    if (!options.body) return Response.json({ category: 'contract', piid: 'PIID', generated_unique_award_id: 'IDV_TEST', recipient: { recipient_uei: 'GLGMWJ8EVMR9' } })
    const body = JSON.parse(options.body)
    return Response.json({ results: body.filters.award_type_codes.includes('A') ? [] : [{ 'Recipient UEI': 'GLGMWJ8EVMR9', generated_internal_id: 'IDV_TEST' }], page_metadata: { hasNext: false } })
  })
  await assert.rejects(fetchPartnerAwardEvidence('GLGMWJ8EVMR9', { signal: AbortSignal.abort() }), { name: 'AbortError' })
  assert.equal(calls, 0)
  await assert.rejects(fetchPartnerAwardEvidence('GLGMWJ8EVMR9'), /Vehicle identity/)
})

test('quarterly refresh defaults on without individual opt-in and honors opt-out', () => {
  assert.equal(partnerRefreshEnabled({}), true)
  assert.equal(partnerRefreshEnabled({ 'USAspending Enabled': '' }), true)
  assert.equal(partnerRefreshEnabled({ 'USAspending Enabled': ' Yes ' }), true)
  assert.equal(partnerRefreshEnabled({ 'USAspending Enabled': ' No ' }), false)
})

test('groups only explicit company groups and retains all subsidiary records', () => {
  const partners = [
    { 'Partner Name': 'Tanaq A', 'UEI Number': 'A', 'Partner Group': 'Tanaq' },
    { 'Partner Name': 'Tanaq B', 'UEI Number': 'B', 'Partner Group': 'tanaq' },
    { 'Partner Name': 'Tanaq unrelated', 'UEI Number': 'C' },
  ]
  const groups = groupPartners(partners)
  assert.equal(groups.length, 2)
  assert.equal(groups[0].members.length, 2)
  assert.equal(partners[1]['UEI Number'], 'B')
})
test('one existing workspace can be shared without editing rows; conflicting links are not merged', () => {
  const a = { 'Link to Partner Folder': 'https://example.com/shared' }
  assert.equal(sharedPartnerWorkspace([{}, a]).partner, a)
  assert.deepEqual(sharedPartnerWorkspace([a, { 'Link to Partner Folder': 'https://example.com/other' }]), { partner: null, conflict: true })
})
test('search routes directly to the matched subsidiary', () => {
  assert.equal(partnerProfilePath({ 'UEI Number': 'ABC123' }), '/partners?partner=ABC123')
})
