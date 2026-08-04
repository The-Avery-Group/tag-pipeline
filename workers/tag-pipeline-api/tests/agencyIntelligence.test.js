import test from 'node:test'
import assert from 'node:assert/strict'
import {
  aggregateVehicleOrders,
  currentFiveFiscalYears,
  finalizeVehicleUsage,
  handleAgencyIntelligence,
  mapAgencyResult,
  mapTopTierReference,
  mapVehicleRecord,
  parentAwardIdFromRecord,
  summarizeVehicleActivity,
} from '../src/handlers/agencyIntelligence.js'

test('builds a five fiscal year window from the current fiscal year', () => {
  assert.deepEqual(currentFiveFiscalYears(new Date('2026-08-04T00:00:00Z')), {
    firstFiscalYear: 2022,
    lastFiscalYear: 2026,
    startDate: '2021-10-01',
    endDate: '2026-08-04',
  })
})

test('derives a parent vehicle from the generated contract award identifier', () => {
  assert.equal(parentAwardIdFromRecord({
    'Award ID': '75D30121F10650',
    generated_internal_id: 'CONT_AWD_75D30121F10650_7523_HHSN316201200025W_7529',
  }), 'HHSN316201200025W')
  assert.equal(parentAwardIdFromRecord({
    'Award ID': 'DIRECT1',
    generated_internal_id: 'CONT_AWD_DIRECT1_7523_-NONE-_-NONE-',
  }), '')
})

test('aggregates order awards by parent vehicle without double counting an order', () => {
  const records = [
    {
      'Award ID': 'ORDER1',
      'Recipient Name': 'Vendor One',
      'Recipient UEI': 'UEI1',
      'Award Amount': 125,
      'Last Modified Date': '2026-07-01',
      NAICS: { code: '541512' },
      PSC: { code: 'DA01' },
      generated_internal_id: 'CONT_AWD_ORDER1_1234_PARENT1_9999',
    },
    {
      'Award ID': 'ORDER2',
      'Recipient Name': 'Vendor Two',
      'Recipient UEI': 'UEI2',
      'Award Amount': 75,
      'Last Modified Date': '2026-07-12',
      NAICS: { code: '541512' },
      PSC: { code: 'R499' },
      generated_internal_id: 'CONT_AWD_ORDER2_1234_PARENT1_9999',
    },
  ]
  const result = finalizeVehicleUsage(aggregateVehicleOrders(records), {
    PARENT1: { description: 'Example Governmentwide Vehicle', generatedId: 'CONT_IDV_PARENT1_9999' },
  })

  assert.equal(result.totals.vehicles, 1)
  assert.equal(result.totals.orders, 2)
  assert.equal(result.totals.contractors, 2)
  assert.equal(result.totals.obligations, 200)
  assert.equal(result.vehicles[0].vehicleName, 'Example Governmentwide Vehicle')
  assert.equal(result.vehicles[0].topNaics, '541512')
  assert.equal(result.vehicles[0].lastUsed, '2026-07-12')
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
