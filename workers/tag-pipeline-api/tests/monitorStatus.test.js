import assert from 'node:assert/strict'
import test from 'node:test'
import { handleRFIFollowUpMonitor } from '../src/handlers/rfiFollowUpMonitor.js'
import { handleSAMMonitor } from '../src/handlers/samMonitor.js'

function request(path) {
  return new Request(`https://worker.example${path}`)
}

function post(path, body) {
  return new Request(`https://worker.example${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
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

test('manual follow-on checks return New-tab matches when KV persistence is unavailable', async () => {
  const env = {
    CACHE: {
      get: async () => null,
      put: async () => { throw new Error('KV write limit reached') },
    },
  }
  const response = await handleRFIFollowUpMonitor(post('/sam/follow-up-monitor/check-one', {
    opportunityId: 'RFI-100',
    watch: {
      opportunityId: 'RFI-100',
      title: 'Enterprise cybersecurity support services',
      department: 'Department of Defense',
      agency: 'Defense Health Agency',
      submissionDate: '2026-01-01',
      rules: {
        monitoringEnabled: true,
        departmentRule: 'Exact', agencyRule: 'Exact', pocRule: 'Ignore',
        titleOverlapPercent: 40, submissionWindowDays: 364,
      },
    },
    newTabRows: [{
      'Notice ID': 'RFP-200', 'Solicitation Number': 'RFP-200',
      Title: 'Enterprise cyber security support service',
      Department: 'Department of Defense', Agency: 'Defense Health Agency',
      'Notice Type': 'RFP', 'Posted Date': '2026-03-01',
    }],
  }), env)
  const result = await response.json()
  assert.equal(response.status, 200)
  assert.equal(result.persisted, false)
  assert.equal(result.watch.candidates.length, 1)
  assert.equal(result.watch.candidates[0].noticeId, 'RFP-200')
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
