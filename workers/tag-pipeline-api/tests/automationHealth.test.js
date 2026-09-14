import assert from 'node:assert/strict'
import test from 'node:test'
import { enrichAutomationRun, getDataRevisions } from '../src/lib/automationHealth.js'

test('change feed reads only scoped metadata and detects category removal', async () => {
  let rows = [{ category: 'fathom-job', version: '2026-09-14T17:00:00Z', records: 1 }]
  const env = { EBUY_DB: { prepare(sql) {
    assert.match(sql, /^SELECT category, MAX\(updated_at\)/)
    assert.doesNotMatch(sql, /payload_json|INSERT|UPDATE|DELETE/)
    return { bind(...categories) {
      assert.ok(categories.includes('follow-on-snapshot'))
      assert.ok(!categories.includes('fathom-input'))
      return { all: async () => ({ results: rows }) }
    } }
  } } }
  const first = await getDataRevisions(env)
  assert.ok(first.revisions.fathom.includes('2026-09-14'))
  rows = []
  assert.notEqual((await getDataRevisions(env)).revisions.fathom, first.revisions.fathom)
  assert.deepEqual(await getDataRevisions({}), { revisions: {} })
})

test('keeps the most recent successful and failed automation outcomes together', () => {
  const successful = enrichAutomationRun(null, { status: 'success', completedAt: '2026-07-25T12:00:00.000Z' })
  const failed = enrichAutomationRun(successful, { status: 'error', completedAt: '2026-07-26T12:00:00.000Z', error: 'SAM API error 500' })

  assert.equal(failed.health.lastSuccessAt, '2026-07-25T12:00:00.000Z')
  assert.equal(failed.health.lastFailureAt, '2026-07-26T12:00:00.000Z')
  assert.equal(failed.health.lastFailureMessage, 'SAM API error 500')
})
