import test from 'node:test'
import assert from 'node:assert/strict'
import {
  handleAgencyIntelligence,
  mapAgencyResult,
  mapTopTierReference,
  mapVehicleRecord,
  samTopTierCode,
  summarizeVehicleActivity,
} from '../src/handlers/agencyIntelligence.js'

test('derives a USAspending top-tier code from a SAM department hierarchy ID', () => {
  assert.equal(samTopTierCode('7500'), '075')
  assert.equal(samTopTierCode('9700'), '097')
  assert.equal(samTopTierCode('75D3'), '')
})


function response(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

test('maps top-tier and sub-tier USAspending agency records', () => {
  const top = mapAgencyResult({
    id: 1173,
    toptier_flag: true,
    toptier_agency: { toptier_code: '097', abbreviation: 'DOD', name: 'Department of Defense' },
    subtier_agency: { abbreviation: 'DOD', name: 'Department of Defense' },
  })
  const sub = mapAgencyResult({
    id: 1216,
    toptier_flag: false,
    toptier_agency: { toptier_code: '097', abbreviation: 'DOD', name: 'Department of Defense' },
    subtier_agency: { abbreviation: 'DARPA', name: 'Defense Advanced Research Projects Agency' },
  })

  assert.deepEqual(top, {
    id: 1173,
    tier: 'toptier',
    name: 'Department of Defense',
    abbreviation: 'DOD',
    toptierCode: '097',
    parentName: 'Department of Defense',
    parentAbbreviation: 'DOD',
  })
  assert.equal(sub.tier, 'subtier')
  assert.equal(sub.name, 'Defense Advanced Research Projects Agency')
  assert.equal(sub.parentName, 'Department of Defense')
})

test('maps the top-tier reference fallback to the agency search shape', () => {
  assert.deepEqual(mapTopTierReference({
    agency_id: 1173,
    toptier_code: '097',
    abbreviation: 'DOD',
    agency_name: 'Department of Defense',
  }), {
    id: 1173,
    tier: 'toptier',
    name: 'Department of Defense',
    abbreviation: 'DOD',
    toptierCode: '097',
    parentName: 'Department of Defense',
    parentAbbreviation: 'DOD',
  })
})

test('maps vehicle fields without relabeling award amount as obligations', () => {
  const vehicle = mapVehicleRecord({
    'Award ID': 'SPE7M225D60JJ',
    'Recipient Name': 'Example Inc.',
    'Recipient UEI': 'ABCDEFGHIJKL',
    'Award Amount': 125000,
    'Contract Award Type': 'INDEFINITE DELIVERY / INDEFINITE QUANTITY',
    'Last Date to Order': '2027-05-02',
    NAICS: { code: '541512', description: 'Computer Systems Design Services' },
    PSC: { code: 'DA01', description: 'IT Services' },
    generated_internal_id: 'CONT_IDV_SPE7M225D60JJ_9700',
  })

  assert.equal(vehicle.awardAmount, 125000)
  assert.equal(vehicle.naicsCode, '541512')
  assert.equal(vehicle.pscCode, 'DA01')
  assert.equal(vehicle.generatedId, 'CONT_IDV_SPE7M225D60JJ_9700')
})

test('summarizes direct and nested IDV order activity', () => {
  const result = summarizeVehicleActivity({
    child_idv_count: 2,
    child_award_count: 25,
    grandchild_award_count: 54,
    child_award_total_obligation: 363410.59,
    grandchild_award_total_obligation: 377145.57,
    child_award_base_and_all_options_value: 297285.59,
    grandchild_award_base_and_all_options_value: 306964.49,
    child_award_base_exercised_options_val: 250000,
    grandchild_award_base_exercised_options_val: 300000,
  }, {
    results: [
      { piid: 'A', recipient_name: 'Vendor One', obligated_amount: 10, grandchild: false },
      { piid: 'B', recipient_name: 'Vendor Two', obligated_amount: 20, grandchild: true },
    ],
    page_metadata: { total: 79, hasNext: true },
  })

  assert.equal(result.totalOrderCount, 79)
  assert.equal(result.totalObligations, 740556.16)
  assert.ok(Math.abs(result.totalPotentialValue - 604250.08) < 0.001)
  assert.equal(result.displayedContractors, 2)
  assert.equal(result.activityTruncated, true)
})

test('vehicle detail skips the activity request when USAspending reports no orders', async (t) => {
  const originalFetch = globalThis.fetch
  let requests = 0
  t.after(() => { globalThis.fetch = originalFetch })
  globalThis.fetch = async () => {
    requests += 1
    return response({
      child_idv_count: 0,
      child_award_count: 0,
      grandchild_award_count: 0,
      child_award_total_obligation: 0,
      grandchild_award_total_obligation: 0,
    })
  }

  const result = await handleAgencyIntelligence(new Request('https://example.com/agency-intelligence/vehicle?awardId=CONT_IDV_HS002126AE002_9700'))
  const payload = await result.json()

  assert.equal(result.status, 200)
  assert.equal(payload.totalOrderCount, 0)
  assert.equal(requests, 1)
})

test('vehicle detail returns totals when only the individual activity list fails', async (t) => {
  const originalFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = originalFetch })
  globalThis.fetch = async (url) => {
    if (String(url).includes('/idvs/amounts/')) {
      return response({
        child_idv_count: 0,
        child_award_count: 2,
        grandchild_award_count: 1,
        child_award_total_obligation: 125,
        grandchild_award_total_obligation: 75,
      })
    }
    return response({ detail: 'Unavailable' }, 503)
  }

  const result = await handleAgencyIntelligence(new Request('https://example.com/agency-intelligence/vehicle?awardId=CONT_IDV_HS002123D0001_9700'))
  const payload = await result.json()

  assert.equal(result.status, 200)
  assert.equal(payload.totalOrderCount, 3)
  assert.equal(payload.totalObligations, 200)
  assert.match(payload.warning, /individual order list/i)
})

test('returns vehicle rows when the optional USAspending count is unavailable', async (t) => {
  const originalFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = originalFetch })
  globalThis.fetch = async (url) => {
    if (String(url).includes('spending_by_award_count')) return response({ detail: 'Unavailable' }, 503)
    return response({
      results: [{
        'Award ID': '75D30125D00195',
        'Recipient Name': 'Example Inc.',
        generated_internal_id: 'CONT_IDV_75D30125D00195_7523',
      }],
      page_metadata: { hasNext: false },
    })
  }

  const request = new Request('https://example.com/agency-intelligence/vehicles?name=CDC&tier=subtier&parent=HHS')
  const result = await handleAgencyIntelligence(request)
  const payload = await result.json()

  assert.equal(result.status, 200)
  assert.equal(payload.totalVehicles, null)
  assert.equal(payload.vehicles.length, 1)
  assert.equal(payload.vehicles[0].awardId, '75D30125D00195')
})

test('reports the upstream USAspending status when vehicle rows fail', async (t) => {
  const originalFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = originalFetch })
  globalThis.fetch = async () => response({ detail: 'Invalid filter' }, 400)

  const request = new Request('https://example.com/agency-intelligence/vehicles?name=CDC&tier=subtier&parent=HHS')
  const result = await handleAgencyIntelligence(request)
  const payload = await result.json()

  assert.equal(result.status, 502)
  assert.equal(payload.code, 'USASPENDING_400')
  assert.equal(payload.error, 'Vehicle data is temporarily unavailable')
})

test('shares a confirmed SAM to USAspending agency crosswalk through KV', async () => {
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
  const candidate = {
    name: 'Centers for Disease Control and Prevention',
    parentName: 'Department of Health and Human Services',
    departmentId: '7500',
    agencyId: '7523',
  }
  const agency = {
    id: 824,
    tier: 'subtier',
    name: 'Centers for Disease Control and Prevention',
    abbreviation: 'CDC',
    toptierCode: '075',
    parentName: 'Department of Health and Human Services',
  }

  const saveResponse = await handleAgencyIntelligence(new Request('https://example.com/agency-intelligence/resolve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ candidate, agency }),
  }), env)
  assert.equal(saveResponse.status, 200)

  const readResponse = await handleAgencyIntelligence(new Request('https://example.com/agency-intelligence/resolve?name=CDC&parent=HHS&departmentId=7500&agencyId=7523'), env)
  const payload = await readResponse.json()
  assert.equal(payload.cache, 'crosswalk')
  assert.equal(payload.agency.id, 824)
  assert.equal(payload.agency.samAgencyId, '7523')
})

test('stores only a validated completed browser vehicle aggregate', async () => {
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
  const url = 'https://example.com/agency-intelligence/usage?name=DCSA&tier=subtier&parent=Department%20of%20Defense&scope=awarding'
  const result = {
    agency: { name: 'DCSA', tier: 'subtier', parentName: 'Department of Defense' },
    scope: 'awarding',
    period: { firstFiscalYear: 2022, lastFiscalYear: 2026, startDate: '2021-10-01', endDate: '2026-08-04' },
    vehicles: [{
      parentAwardId: 'HS002123D0001',
      vehicleName: 'Example vehicle',
      orders: 2,
      contractors: 1,
      obligations: 250,
      sampleOrders: [],
    }],
    totals: { contractors: 1 },
    processedOrders: 2,
    unlinkedOrders: 0,
    fetchedAt: '2026-08-04T10:00:00.000Z',
  }

  const saveResponse = await handleAgencyIntelligence(new Request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ result }),
  }), env)
  assert.equal(saveResponse.status, 200)

  const readResponse = await handleAgencyIntelligence(new Request(url), env)
  const payload = await readResponse.json()
  assert.equal(payload.status, 'ready')
  assert.equal(payload.result.transport, 'browser')
  assert.equal(payload.result.totals.vehicles, 1)
  assert.equal(payload.result.totals.orders, 2)
  assert.equal(payload.result.totals.obligations, 250)
})

test('does not cache a browser aggregate under a different agency', async () => {
  const env = { CACHE: { async get() { return null }, async put() {} } }
  const response = await handleAgencyIntelligence(new Request('https://example.com/agency-intelligence/usage?name=DCSA&scope=funding', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      result: { agency: { name: 'Department of the Army' }, scope: 'funding', vehicles: [] },
    }),
  }), env)
  assert.equal(response.status, 400)
  assert.match((await response.json()).error, /does not match/i)
})
