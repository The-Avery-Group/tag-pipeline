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
    async do(_name, callback) {
      return callback()
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
  assert.deepEqual(createdBatch, [{
    id: 'ebuy-archive-run-123-3',
    params: {
      mode: 'live',
      source: 'manual',
      resumeRunId: 'run-123',
      archiveCheckpoint: 3,
    },
    retention: { successRetention: '3 days', errorRetention: '7 days' },
  }])
})

test('eBuy continuation IDs remove unsafe workflow characters', () => {
  assert.equal(ebuyArchiveContinuationId('run/with spaces', 4), 'ebuy-archive-run-with-spaces-4')
})
