import assert from 'node:assert/strict'
import test from 'node:test'
import { startScheduledSAMPull } from '../src/handlers/sam.js'

test('scheduled SAM pulls create one idempotent workflow instance per day', async () => {
  let batch = null
  const env = {
    SAM_PULL_WORKFLOW: {
      async createBatch(value) {
        batch = value
        return [{ id: value[0].id }]
      },
    },
  }

  const result = await startScheduledSAMPull(env, Date.parse('2026-07-27T12:00:00.000Z'))

  assert.equal(result.started, true)
  assert.equal(result.instanceId, 'sam-pull-2026-07-27')
  assert.deepEqual(batch, [{
    id: 'sam-pull-2026-07-27',
    params: { scheduledTime: '2026-07-27T12:00:00.000Z' },
    retention: { successRetention: '1 day', errorRetention: '3 days' },
  }])
})

test('an existing scheduled SAM workflow is treated as already started', async () => {
  const env = {
    SAM_PULL_WORKFLOW: {
      async createBatch() {
        return []
      },
    },
  }

  const result = await startScheduledSAMPull(env, Date.parse('2026-07-27T12:00:00.000Z'))

  assert.equal(result.started, false)
  assert.equal(result.instanceId, 'sam-pull-2026-07-27')
})
