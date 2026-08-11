import assert from 'node:assert/strict'
import test from 'node:test'
import {
  contractEligibility,
  resolveLastModifiedBy,
  runExpiringContractsRefresh,
  startExpiringContractsRefresh,
  summarizeAwardFamily,
} from '../src/handlers/expiringContracts.js'
import { solicitationFamily } from '../src/handlers/sam.js'

function award({
  modificationNumber = '0',
  reasonCode = '',
  reasonName = '',
  dateSigned = '2026-01-01',
  currentCompletionDate = '2027-08-01',
  ultimateCompletionDate = '2028-02-01',
  lastModifiedBy = 'HHSAHAYNES',
} = {}) {
  return {
    contractId: {
      subtier: { code: '7523', name: 'CENTERS FOR DISEASE CONTROL AND PREVENTION' },
      piid: '75D30126C00001',
      modificationNumber,
      transactionNumber: '0',
      reasonForModification: { code: reasonCode, name: reasonName },
      referencedIDVSubtier: { code: '4700', name: 'GENERAL SERVICES ADMINISTRATION' },
      referencedIDVPiid: '47QTCA20D0001',
    },
    coreData: {
      awardOrIDV: 'Award',
      title: 'Program support services',
      solicitationId: '75D30126R00001',
      awardOrIDVType: { name: 'DEFINITIVE CONTRACT' },
      federalOrganization: { contractingInformation: {
        contractingDepartment: { code: '7500', name: 'HEALTH AND HUMAN SERVICES, DEPARTMENT OF' },
        contractingSubtier: { code: '7523', name: 'CENTERS FOR DISEASE CONTROL AND PREVENTION' },
        contractingOffice: { code: '75D301', name: 'CDC OFFICE OF ACQUISITION SERVICES' },
      } },
      productOrServiceInformation: { principalNaics: [{ code: '541611' }] },
    },
    awardDetails: {
      dates: { dateSigned, currentCompletionDate, ultimateCompletionDate, periodOfPerformanceStartDate: '2026-01-01', fiscalYear: '2026' },
      transactionData: { lastModifiedDate: dateSigned, lastModifiedBy },
      awardeeData: {
        awardeeHeader: { awardeeName: 'EXAMPLE INC.' },
        awardeeUEIInformation: { uniqueEntityId: 'ABCDEFGHIJKL' },
      },
      totalContractDollars: { totalBaseAndAllOptionsValue: 5000000, totalActionObligation: 100000 },
      productOrServiceInformation: { descriptionOfContractRequirement: 'Program support services' },
    },
  }
}

test('a later option exercise clears an earlier termination lifecycle flag', () => {
  const records = [
    award({ modificationNumber: 'P00001', reasonCode: 'E', reasonName: 'Terminate for Default', dateSigned: '2025-10-01' }),
    award({ modificationNumber: 'P00002', reasonCode: 'G', reasonName: 'Exercise an Option', dateSigned: '2026-07-01' }),
  ]
  const result = contractEligibility(records, new Date('2026-08-11T00:00:00Z'))
  assert.equal(result.eligible, true)
  assert.equal(result.reason, 'recent-option')
})

test('an old option period with no current work is excluded', () => {
  const records = [award({
    modificationNumber: 'P00003',
    reasonCode: 'G',
    reasonName: 'Exercise an Option',
    dateSigned: '2024-06-01',
    currentCompletionDate: '2025-06-01',
    ultimateCompletionDate: '2027-02-01',
  })]
  assert.equal(contractEligibility(records, new Date('2026-08-11T00:00:00Z')).eligible, false)
})

test('award family summary uses ultimate completion and total base plus all options', () => {
  const summary = summarizeAwardFamily([award()], new Date('2026-08-11T00:00:00Z'))
  assert.equal(summary.ultimateCompletionDate, '2028-02-01')
  assert.equal(summary.totalContractValue, 5000000)
  assert.equal(summary.piid, '75D30126C00001')
  assert.equal(summary.agencyCode, '7523')
})

test('HHS modifier identifiers resolve from public notice contact names', () => {
  const contact = { name: 'Amanda Haynes', email: 'amanda.haynes@hhs.gov', noticeId: 'abc', sourceLink: 'https://sam.gov/opp/abc' }
  const result = resolveLastModifiedBy('HHSAHAYNES', 'CENTERS FOR DISEASE CONTROL AND PREVENTION', [contact])
  assert.equal(result.status, 'matched')
  assert.equal(result.matches[0].name, 'Amanda Haynes')
})

test('dismissal matching collapses amendment-style solicitation suffixes', () => {
  assert.equal(solicitationFamily('W912AB26R0001_001'), 'W912AB26R0001')
  assert.equal(solicitationFamily('W912AB26R0001-AMENDMENT-2'), 'W912AB26R0001')
})

test('manual expiring refresh creates a durable Workflow instance', async () => {
  let created
  const env = {
    CACHE: { async put() {}, async get() { return null } },
    EXPIRING_CONTRACTS_WORKFLOW: {
      async createBatch(batch) { created = batch; return [{ id: batch[0].id }] },
    },
  }
  const result = await startExpiringContractsRefresh(env, {
    agencies: [{ id: 'cdc', label: 'CDC', searchName: 'CENTERS FOR DISEASE CONTROL AND PREVENTION', tier: 'subtier' }],
    scheduledTime: Date.parse('2026-08-11T00:00:00Z'),
  })
  assert.equal(result.started, true)
  assert.equal(created[0].params.agencies[0].id, 'cdc')
  assert.equal(created[0].params.checkpoint, 1)
  assert.equal(created[0].params.continuation.agencyIndex, 0)
})

test('an expiring Workflow instance fetches a bounded page batch before continuing', async () => {
  const previousFetch = globalThis.fetch
  let fetchCount = 0
  let created = null
  const values = new Map()
  globalThis.fetch = async () => {
    fetchCount += 1
    return new Response(JSON.stringify({
      totalRecords: 700,
      awardSummary: Array.from({ length: 100 }, (_, index) => award({
        modificationNumber: `P${String(fetchCount * 100 + index).padStart(5, '0')}`,
      })),
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }
  const env = {
    SAM_API_KEY: 'test-key',
    CACHE: {
      async get(key, type) {
        const value = values.get(key)
        return type === 'json' && value ? JSON.parse(value) : value || null
      },
      async put(key, value) { values.set(key, value) },
      async delete(key) { values.delete(key) },
    },
    EXPIRING_CONTRACTS_WORKFLOW: {
      async createBatch(batch) { created = batch; return [{ id: batch[0].id }] },
    },
  }
  const step = {
    async do(_name, optionsOrCallback, maybeCallback) {
      return (maybeCallback || optionsOrCallback)()
    },
  }

  try {
    const result = await runExpiringContractsRefresh(env, {
      instanceId: 'expiring-test-1',
      payload: {
        runId: 'test-run',
        checkpoint: 1,
        agencies: [{ id: 'cdc', label: 'CDC', searchName: 'CENTERS FOR DISEASE CONTROL AND PREVENTION', tier: 'subtier' }],
        continuation: {
          startedAt: '2026-08-11T00:00:00.000Z',
          naicsCodes: ['541611'],
          agencyIndex: 0,
          offset: 0,
          pageNumber: 0,
          storedRecordCount: 0,
          totalContracts: 0,
          agencyErrors: [],
        },
      },
    }, step)

    assert.equal(fetchCount, 6)
    assert.equal(result.status, 'continuing')
    assert.equal(result.nextCheckpoint, 2)
    assert.equal(created[0].params.continuation.pageNumber, 6)
    assert.equal(created[0].params.continuation.offset, 600)
  } finally {
    globalThis.fetch = previousFetch
  }
})
