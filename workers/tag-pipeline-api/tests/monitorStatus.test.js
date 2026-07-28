import assert from 'node:assert/strict'
import test from 'node:test'
import { handleRFIFollowUpMonitor } from '../src/handlers/rfiFollowUpMonitor.js'
import { handleSAMMonitor } from '../src/handlers/samMonitor.js'

function request(path) {
  return new Request(`https://worker.example${path}`)
}

test('RFI status stays available when the snapshot is corrupt and its repair write fails', async () => {
  const env = {
    CACHE: {
      get: async (_key, type) => type === 'json' ? null : '{invalid json',
      list: async () => ({ keys: [] }),
      put: async () => { throw new Error('KV write limit reached') },
    },
  }
  const response = await handleRFIFollowUpMonitor(
    request('/sam/follow-up-monitor/status'),
    env,
  )
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { watches: [], run: null })
})

test('RFI status fails open when KV watch reads are temporarily unavailable', async () => {
  const env = {
    CACHE: {
      get: async () => null,
      list: async () => { throw new Error('KV unavailable') },
    },
  }
  const response = await handleRFIFollowUpMonitor(
    request('/sam/follow-up-monitor/status'),
    env,
  )
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), {
    watches: [],
    run: null,
    temporarilyUnavailable: true,
  })
})

test('SAM status fails open when the snapshot and watch fallback are unavailable', async () => {
  const env = {
    CACHE: {
      get: async () => null,
      list: async () => { throw new Error('KV unavailable') },
    },
  }
  const response = await handleSAMMonitor(
    request('/sam/changes/status'),
    env,
  )
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), {
    watches: [],
    run: null,
    temporarilyUnavailable: true,
  })
})
