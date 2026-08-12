import assert from 'node:assert/strict'
import test from 'node:test'
import { isFlaggedSAMOpportunity, normalizeDiscoveryNoticeType, parseOrg, parsePOC, startScheduledSAMPull } from '../src/handlers/sam.js'
import { runSAMPullWorkflowCheckpoint } from '../src/workflows/samPullChain.js'

test('shared SAM flags are recognized for cleanup protection', () => {
  assert.equal(isFlaggedSAMOpportunity({ Flagged: 'Yes' }), true)
  assert.equal(isFlaggedSAMOpportunity({ Flagged: '' }), false)
})

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

test('a missing Workflow binding fails clearly instead of leaving a partial pull', async () => {
  const result = await startScheduledSAMPull({}, Date.parse('2026-07-27T12:00:00.000Z'))

  assert.equal(result.ok, false)
  assert.equal(result.source, 'workflow')
  assert.match(result.error, /binding is unavailable/)
})

test('a partial scheduled checkpoint immediately creates the next workflow instance', async () => {
  const continuation = {
    status: 'partial',
    runId: 'run-123',
    nextCursor: { naicsIndex: 2, offset: 10 },
    totalFetched: 20,
    totalWritten: 3,
  }
  let createdBatch = null
  const env = {
    SAM_PULL_WORKFLOW: {
      async createBatch(batch) {
        createdBatch = batch
        return [{ id: batch[0].id }]
      },
    },
  }
  const step = {
    async do(_name, optionsOrCallback, maybeCallback) {
      const callback = maybeCallback || optionsOrCallback
      return callback()
    },
  }

  const result = await runSAMPullWorkflowCheckpoint({
    env,
    event: { instanceId: 'sam-pull-2026-07-27', payload: {} },
    step,
    runCheckpoint: async () => ({
      ok: true,
      result: continuation,
    }),
  })

  assert.equal(result.status, 'continuing')
  assert.equal(result.nextCheckpoint, 2)
  assert.equal(result.nextInstanceId, 'sam-pull-run-123-2')
  assert.deepEqual(createdBatch, [{
    id: 'sam-pull-run-123-2',
    params: {
      checkpoint: 2,
      continuation,
    },
    retention: { successRetention: '1 day', errorRetention: '3 days' },
  }])
})

test('a chained checkpoint resumes from its event payload and completes', async () => {
  const previous = {
    status: 'partial',
    runId: 'run-456',
    nextCursor: { naicsIndex: 3, offset: 0 },
    totalFetched: 30,
    totalWritten: 4,
  }
  let receivedContinuation = null
  const step = {
    async do(_name, optionsOrCallback, maybeCallback) {
      const callback = maybeCallback || optionsOrCallback
      return callback()
    },
  }

  const result = await runSAMPullWorkflowCheckpoint({
    env: {},
    event: {
      instanceId: 'sam-pull-run-456-2',
      payload: { checkpoint: 2, continuation: previous },
    },
    step,
    runCheckpoint: async (_env, continuation) => {
      receivedContinuation = continuation
      return {
        ok: true,
        result: {
          status: 'success',
          runId: 'run-456',
          totalFetched: 36,
          totalWritten: 5,
          completedAt: '2026-07-28T12:00:00.000Z',
        },
      }
    },
  })

  assert.equal(receivedContinuation, previous)
  assert.equal(result.status, 'complete')
  assert.equal(result.checkpoints, 2)
  assert.equal(result.totalWritten, 5)
})

test('a chained checkpoint fails when its cursor does not advance', async () => {
  const previous = {
    status: 'partial',
    runId: 'run-789',
    nextCursor: { naicsIndex: 4, offset: 20 },
  }
  const step = {
    async do(_name, optionsOrCallback, maybeCallback) {
      const callback = maybeCallback || optionsOrCallback
      return callback()
    },
  }

  await assert.rejects(
    runSAMPullWorkflowCheckpoint({
      env: {},
      event: {
        instanceId: 'sam-pull-run-789-3',
        payload: { checkpoint: 3, continuation: previous },
      },
      step,
      runCheckpoint: async () => ({
        ok: true,
        result: {
          ...previous,
          totalFetched: 40,
          totalWritten: 6,
        },
      }),
    }),
    /did not advance/,
  )
})

test('SAM discovery classifies compact and descriptive procurement types consistently', () => {
  assert.equal(normalizeDiscoveryNoticeType('r'), 'RFI')
  assert.equal(normalizeDiscoveryNoticeType('o'), 'RFP')
  assert.equal(normalizeDiscoveryNoticeType('k'), 'RFQ')
  assert.equal(normalizeDiscoveryNoticeType('MRAS'), 'MRAS')
  assert.equal(normalizeDiscoveryNoticeType('Market Research Notice'), 'MRAS')
  assert.equal(normalizeDiscoveryNoticeType('Solicitation'), 'RFP')
  assert.equal(normalizeDiscoveryNoticeType('Combined Synopsis/Solicitation'), 'RFQ')
  assert.equal(
    normalizeDiscoveryNoticeType('Solicitation', 'Combined Synopsis/Solicitation'),
    'RFQ',
  )
})

test('SAM discovery retains all unique points of contact with the primary first', () => {
  assert.equal(parsePOC([
    { type: 'secondary', fullName: 'Secondary Person', email: 'secondary@example.gov', phone: '222' },
    { type: 'primary', fullName: 'Primary Person', email: 'primary@example.gov', phone: '111' },
    { type: 'secondary', fullName: 'Duplicate', email: 'secondary@example.gov', phone: '333' },
  ]), 'Primary Person | primary@example.gov | 111\nSecondary Person | secondary@example.gov | 222')
})

test('SAM hierarchy names stay aligned by level', () => {
  assert.deepEqual(
    parseOrg('DEPT OF DEFENSE.DEPT OF THE ARMY.W6QM MICC-FT KNOX'),
    {
      department: 'DEPT OF DEFENSE',
      agency: 'DEPT OF THE ARMY',
      office: 'W6QM MICC-FT KNOX',
    },
  )
})
