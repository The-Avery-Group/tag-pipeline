import assert from 'node:assert/strict'
import test from 'node:test'
import {
  contractEligibility,
  expiringHiddenKey,
  fetchExpiringAwardsPage,
  normalizeExpiringAgency,
  resolveExpiringAgencies,
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

test('official SAM agency metadata preserves the tier, organization ID, and award-search code', () => {
  const agency = normalizeExpiringAgency({
    fhorgid: '100006106',
    fhorgname: 'DEFENSE HEALTH AGENCY',
    agencycode: '9700',
    searchName: 'DEFENSE HEALTH AGENCY',
    tier: 'subtier',
  })
  assert.equal(agency.tier, 'subtier')
  assert.equal(agency.organizationId, '100006106')
  assert.equal(agency.agencyCode, '9700')
})

test('agency resolution returns official active SAM hierarchy matches', async () => {
  const previousFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    assert.match(String(url), /federalorganizations\/v1\/orgs/)
    assert.match(String(url), /status=active/)
    return new Response(JSON.stringify({
      orglist: [{
        fhorgid: '100006106',
        fhorgname: 'DEFENSE HEALTH AGENCY',
        fhorgtype: 'Sub-Tier',
        agencycode: '9700',
        fhagencyorgname: 'DEPARTMENT OF DEFENSE',
      }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }
  try {
    const matches = await resolveExpiringAgencies({
      SAM_API_KEY: 'test-key',
      CACHE: { async get() { return null } },
    }, 'Defense Health')
    const match = matches.find((agency) => agency.organizationId === '100006106')
    assert.equal(match.label, 'DEFENSE HEALTH AGENCY')
    assert.equal(match.tier, 'subtier')
    assert.equal(match.agencyCode, '9700')
  } finally {
    globalThis.fetch = previousFetch
  }
})

test('award discovery filters official subagencies by code instead of a guessed name', async () => {
  const previousFetch = globalThis.fetch
  let requestUrl = ''
  globalThis.fetch = async (url) => {
    requestUrl = String(url)
    return new Response(null, { status: 204 })
  }
  try {
    await fetchExpiringAwardsPage({ SAM_API_KEY: 'test-key' }, {
      agency: {
        id: 'fh-100006106',
        label: 'Defense Health Agency',
        searchName: 'DEFENSE HEALTH AGENCY',
        tier: 'subtier',
        organizationId: '100006106',
        agencyCode: '9700',
      },
      naicsCodes: ['541611'],
      now: new Date('2026-08-12T00:00:00Z'),
    })
    const params = new URL(requestUrl).searchParams
    assert.equal(params.get('contractingSubtierCode'), '9700')
    assert.equal(params.has('contractingSubtierName'), false)
  } finally {
    globalThis.fetch = previousFetch
  }
})

test('shared hidden-contract keys are deterministic and contract-specific', () => {
  assert.equal(expiringHiddenKey('9700|ABC-1||'), expiringHiddenKey('9700|ABC-1||'))
  assert.notEqual(expiringHiddenKey('9700|ABC-1||'), expiringHiddenKey('9700|ABC-2||'))
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

test('scheduled refresh includes saved official target agencies', async () => {
  let created
  const customAgency = {
    id: 'fh-100099999',
    label: 'Example Agency',
    searchName: 'EXAMPLE AGENCY',
    tier: 'subtier',
    organizationId: '100099999',
    agencyCode: '9999',
    custom: true,
    scheduled: true,
  }
  const env = {
    CACHE: {
      async get(key, type) {
        if (key === 'expiring_contracts:agency_registry:v1' && type === 'json') return [customAgency]
        return null
      },
      async put() {},
    },
    EXPIRING_CONTRACTS_WORKFLOW: {
      async createBatch(batch) { created = batch; return [{ id: batch[0].id }] },
    },
  }
  await startExpiringContractsRefresh(env, {
    scheduledTime: Date.parse('2026-08-12T00:00:00Z'),
    source: 'scheduled',
  })
  assert.ok(created[0].params.agencies.some((agency) => agency.id === customAgency.id))
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

test('large checkpoint collections stay outside persisted Workflow step outputs', async () => {
  const previousFetch = globalThis.fetch
  const runId = 'large-run'
  const agency = { id: 'army', label: 'Army', searchName: 'DEPT OF THE ARMY', tier: 'subtier' }
  const recordsKey = `expiring_contracts:run_records:v1:${runId}:${agency.id}`
  const priorRecords = Array.from({ length: 600 }, (_, index) => {
    const record = award({ modificationNumber: `P${String(index).padStart(5, '0')}` })
    record.awardDetails.productOrServiceInformation.descriptionOfContractRequirement = `Requirement ${index} ${'x'.repeat(2200)}`
    return record
  })
  const values = new Map([[recordsKey, JSON.stringify(priorRecords)]])
  assert.ok(Buffer.byteLength(values.get(recordsKey)) > 1024 * 1024)

  globalThis.fetch = async () => new Response(JSON.stringify({
    totalRecords: 700,
    awardSummary: Array.from({ length: 100 }, (_, index) => award({
      modificationNumber: `P${String(600 + index).padStart(5, '0')}`,
    })),
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })

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
      async createBatch(batch) { return [{ id: batch[0].id }] },
    },
  }
  const outputs = new Map()
  const step = {
    async do(name, optionsOrCallback, maybeCallback) {
      const result = await (maybeCallback || optionsOrCallback)()
      const serialized = JSON.stringify(result)
      if (serialized) assert.ok(Buffer.byteLength(serialized) <= 1024 * 1024, `${name} exceeded 1 MiB`)
      outputs.set(name, result)
      return result
    },
  }

  try {
    const result = await runExpiringContractsRefresh(env, {
      instanceId: 'expiring-large-2',
      payload: {
        runId,
        checkpoint: 2,
        agencies: [agency],
        continuation: {
          startedAt: '2026-08-11T00:00:00.000Z',
          naicsCodes: ['541611'],
          agencyIndex: 0,
          offset: 600,
          pageNumber: 6,
          currentPages: 7,
          storedRecordCount: priorRecords.length,
          totalContracts: 0,
          agencyErrors: [],
        },
      },
    }, step)

    assert.equal(result.status, 'success')
    assert.deepEqual(outputs.get('Verify army checkpoint records 2'), { key: recordsKey, count: 600 })
    assert.deepEqual(outputs.get('Save army expiring contracts'), { contractCount: 1 })
  } finally {
    globalThis.fetch = previousFetch
  }
})
