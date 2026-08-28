import assert from 'node:assert/strict'
import test from 'node:test'
import {
  EBUY_ARCHIVE_FILES_PER_CHECKPOINT,
  ebuyArchiveContinuationId,
  scheduleEbuyArchiveContinuation,
} from '../src/workflows/ebuySyncChain.js'

test('eBuy file archiving uses a conservative per-instance batch', () => {
  assert.equal(EBUY_ARCHIVE_FILES_PER_CHECKPOINT, 4)
})

test('eBuy archive continuation preserves the run and advances the checkpoint', async () => {
  let createdBatch = null
  const env = {
    EBUY_SYNC_WORKFLOW: {
      async createBatch(batch) {
        createdBatch = batch
        return [{ id: batch[0].id }]
      },
    },
  }
  const step = {
    async do(_name, configOrCallback, callback) {
      return (callback || configOrCallback)()
    },
  }

  const result = await scheduleEbuyArchiveContinuation({
    env,
    step,
    runId: 'run-123',
    checkpoint: 2,
    source: 'manual',
  })

  assert.equal(result.checkpoint, 3)
  assert.equal(result.instanceId, 'ebuy-archive-run-123-3')
  assert.equal(result.started, true)
  assert.equal(result.reused, false)
  assert.deepEqual(createdBatch, [{
    id: 'ebuy-archive-run-123-3',
    params: {
      mode: 'live',
      source: 'manual',
      resumeRunId: 'run-123',
      archiveCheckpoint: 3,
      continuationKey: 'run-123',
    },
    retention: { successRetention: '3 days', errorRetention: '7 days' },
  }])
})

test('eBuy continuation IDs remove unsafe workflow characters', () => {
  assert.equal(ebuyArchiveContinuationId('run/with spaces', 4), 'ebuy-archive-run-with-spaces-4')
})

test('eBuy archive continuation treats an existing idempotent checkpoint as successful', async () => {
  const env = {
    EBUY_SYNC_WORKFLOW: {
      async createBatch() { return [] },
    },
  }
  const step = {
    async do(_name, configOrCallback, callback) { return (callback || configOrCallback)() },
  }

  const result = await scheduleEbuyArchiveContinuation({
    env,
    step,
    runId: 'run-123',
    checkpoint: 2,
    source: 'manual',
  })

  assert.deepEqual(result, {
    checkpoint: 3,
    instanceId: 'ebuy-archive-run-123-3',
    started: false,
    reused: true,
  })
})

test('a resumed eBuy chain derives every checkpoint id from its stable new chain key', async () => {
  let createdBatch = null
  const env = {
    EBUY_SYNC_WORKFLOW: {
      async createBatch(batch) {
        createdBatch = batch
        return [{ id: batch[0].id }]
      },
    },
  }
  const step = {
    async do(_name, _config, callback) {
      return (callback || _config)()
    },
  }

  const result = await scheduleEbuyArchiveContinuation({
    env,
    step,
    runId: 'original-run',
    continuationKey: 'new-resume-parent',
    checkpoint: 1,
    source: 'manual',
  })

  assert.equal(result.instanceId, 'ebuy-archive-new-resume-parent-2')
  assert.equal(createdBatch[0].params.continuationKey, 'new-resume-parent')
})
