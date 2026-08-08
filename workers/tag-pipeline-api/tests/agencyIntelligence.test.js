import test from 'node:test'
import assert from 'node:assert/strict'
import {
  compactContract,
  compactVehicle,
  handleAgencyIntelligence,
  mapAgencyRecords,
} from '../src/handlers/agencyIntelligence.js'

function response(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

const sample = {
  contractId: {
    piid: '75D30125F1234',
    referencedIDVPiid: '47QTCA20D0001',
    referencedIDVSubtier: { code: '4732', name: 'Federal Acquisition Service' },
  },
  coreData: {
    title: 'Public health support order',
    awardOrIDVType: { name: 'DELIVERY ORDER' },
    federalOrganization: {
      contractingInformation: {
        contractingDepartment: { code: '7500', name: 'Department of Health and Human Services' },
        contractingSubtier: { code: '7523', name: 'Centers for Disease Control and Prevention' },
      },
    },
    competitionInformation: { typeOfSetAside: { name: 'SMALL BUSINESS SET-ASIDE - TOTAL' } },
  },
  awardDetails: {
    dates: { dateSigned: '2026-01-12' },
    awardeeData: {
      awardeeHeader: { awardeeName: 'Example Contractor LLC' },
      awardeeUEIInformation: { uniqueEntityId: 'ABCDEFGHIJKL' },
    },
    totalContractDollars: {
      totalBaseAndAllOptionsValue: 1250000,
      totalActionObligation: 250000,
    },
  },
}

test('maps official SAM department and agency identifiers from award records', () => {
  const agencies = mapAgencyRecords([sample])
  assert.equal(agencies.length, 2)
  assert.deepEqual(agencies.find((agency) => agency.tier === 'subtier'), {
    tier: 'subtier',
    name: 'Centers for Disease Control and Prevention',
    parentName: 'Department of Health and Human Services',
    departmentId: '7500',
    agencyId: '7523',
  })
})

test('compacts a SAM order and preserves total contract value', () => {
  const contract = compactContract(sample)
  assert.equal(contract.awardId, '75D30125F1234')
  assert.equal(contract.parentAwardId, '47QTCA20D0001')
  assert.equal(contract.contractingAgencyId, '7523')
  assert.equal(contract.totalContractValue, 1250000)
  assert.equal(contract.totalObligations, 250000)
})

test('uses the latest SAM IDV modification when resolving vehicle metadata', () => {
  const vehicle = compactVehicle([
    { ...sample, contractId: { piid: '47QTCA20D0001' }, coreData: { ...sample.coreData, title: 'Initial title' } },
    { ...sample, contractId: { piid: '47QTCA20D0001' }, coreData: { ...sample.coreData, title: 'GSA Multiple Award Schedule' }, awardDetails: { ...sample.awardDetails, dates: { dateSigned: '2026-07-01' } } },
  ], { piid: '47qtca20d0001', agencyId: '4732' })
  assert.equal(vehicle.piid, '47QTCA20D0001')
  assert.equal(vehicle.title, 'GSA Multiple Award Schedule')
  assert.equal(vehicle.totalContractValue, 1250000)
})

test('loads one bounded SAM contract page for a target agency', async (t) => {
  const originalFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = originalFetch })
  globalThis.fetch = async (url) => {
    const parsed = new URL(url)
    assert.equal(parsed.searchParams.get('contractingSubtierCode'), '7523')
    assert.equal(parsed.searchParams.get('limit'), '100')
    return response({ awardSummary: [sample], totalRecords: 1 })
  }
  const result = await handleAgencyIntelligence(
    new Request('https://example.com/agency-intelligence/contracts?name=CDC&tier=subtier&departmentId=7500&agencyId=7523&offset=0'),
    { SAM_API_KEY: 'test' },
  )
  const payload = await result.json()
  assert.equal(result.status, 200)
  assert.equal(payload.records.length, 1)
  assert.equal(payload.records[0].totalContractValue, 1250000)
  assert.equal(payload.hasNext, false)
})

test('keeps a vehicle resolution batch usable when one SAM IDV lookup fails', async (t) => {
  const originalFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = originalFetch })
  globalThis.fetch = async (url) => {
    const piid = new URL(url).searchParams.get('piid')
    if (piid === 'BAD-IDV') return response({ message: 'Temporary failure' }, 503)
    return response({
      awardSummary: [{
        ...sample,
        contractId: { piid },
        coreData: { ...sample.coreData, title: 'GSA Multiple Award Schedule' },
      }],
      totalRecords: 1,
    })
  }
  const result = await handleAgencyIntelligence(new Request('https://example.com/agency-intelligence/vehicles/resolve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifiers: [
      { piid: '47QTCA20D0001', agencyId: '4732' },
      { piid: 'BAD-IDV', agencyId: '4732' },
    ] }),
  }), { SAM_API_KEY: 'test' })
  const payload = await result.json()
  assert.equal(result.status, 200)
  assert.equal(payload.resolutions.length, 2)
  assert.equal(payload.failed, 1)
  assert.equal(payload.resolutions.find((item) => item.piid === 'BAD-IDV').resolutionError, true)
})

test('returns a normal cache-miss response instead of a report 404', async () => {
  const result = await handleAgencyIntelligence(
    new Request('https://example.com/agency-intelligence/report?name=CDC&tier=subtier'),
    { CACHE: { async get() { return null } } },
  )
  assert.equal(result.status, 200)
  assert.equal((await result.json()).status, 'missing')
})

test('stores only completed SAM.gov reports in shared cache', async () => {
  const entries = new Map()
  const env = {
    CACHE: {
      async get(key, type) {
        const value = entries.get(key)
        return type === 'json' && value ? JSON.parse(value) : value || null
      },
      async put(key, value) { entries.set(key, value) },
    },
  }
  const url = 'https://example.com/agency-intelligence/report?name=CDC&tier=subtier&departmentId=7500&agencyId=7523'
  const report = {
    source: 'SAM.gov',
    vehicles: [{ vehicleName: 'GSA Multiple Award Schedule', recordCount: 4 }],
    totals: { vehicleFamilies: 1, contracts: 4, totalContractValue: 5000000 },
  }
  const saved = await handleAgencyIntelligence(new Request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ result: report }),
  }), env)
  assert.equal(saved.status, 200)
  const read = await handleAgencyIntelligence(new Request(url), env)
  assert.deepEqual((await read.json()).result, report)
})
