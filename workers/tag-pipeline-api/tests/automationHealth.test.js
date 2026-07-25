import assert from 'node:assert/strict'
import test from 'node:test'
import { enrichAutomationRun } from '../src/lib/automationHealth.js'

test('keeps the most recent successful and failed automation outcomes together', () => {
  const successful = enrichAutomationRun(null, { status: 'success', completedAt: '2026-07-25T12:00:00.000Z' })
  const failed = enrichAutomationRun(successful, { status: 'error', completedAt: '2026-07-26T12:00:00.000Z', error: 'SAM API error 500' })

  assert.equal(failed.health.lastSuccessAt, '2026-07-25T12:00:00.000Z')
  assert.equal(failed.health.lastFailureAt, '2026-07-26T12:00:00.000Z')
  assert.equal(failed.health.lastFailureMessage, 'SAM API error 500')
})
