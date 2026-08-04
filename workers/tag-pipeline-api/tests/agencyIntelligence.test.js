import test from 'node:test'
import assert from 'node:assert/strict'
import {
  handleAgencyIntelligence,
  mapAgencyResult,
  mapTopTierReference,
  mapVehicleRecord,
  summarizeVehicleActivity,
} from '../src/handlers/agencyIntelligence.js'

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
