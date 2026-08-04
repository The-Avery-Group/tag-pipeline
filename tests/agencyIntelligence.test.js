import test from 'node:test'
import assert from 'node:assert/strict'
import {
  agencyIdPatch,
  buildSAMAgencyIdReference,
  findExactAgencyMatch,
  findPipelineAgencyMatch,
  mapOfficialAgencyResults,
  pipelineAgencySearchTerms,
} from '../src/lib/agencyIntelligence.js'
import {
  agencyUsageFilters,
  aggregateVehicleOrders,
  currentFiveFiscalYears,
  finalizeVehicleUsage,
  normalizeAwardIds,
  parentAwardIdFromRecord,
} from '../src/lib/agencyVehicleUsage.js'

test('sends raw parent award IDs to USAspending without embedded quotes', () => {
  assert.deepEqual(
    normalizeAwardIds([' hs002123d0001 ', 'HS002123D0001', 'HS002126AE002']),
    ['HS002123D0001', 'HS002126AE002'],
  )
})

test('builds the browser-direct five fiscal year usage filter', () => {
  const now = new Date('2026-08-04T00:00:00Z')
  assert.deepEqual(currentFiveFiscalYears(now), {
    firstFiscalYear: 2022,
    lastFiscalYear: 2026,
    startDate: '2021-10-01',
    endDate: '2026-08-04',
  })
  assert.deepEqual(agencyUsageFilters({
    name: 'Defense Counterintelligence and Security Agency',
    tier: 'subtier',
    parentName: 'Department of Defense',
  }, 'awarding', now).agencies, [{
    type: 'awarding',
    tier: 'subtier',
    name: 'Defense Counterintelligence and Security Agency',
    toptier_name: 'Department of Defense',
  }])
})

test('aggregates browser-direct order pages by parent vehicle', () => {
  const records = [{
    'Award ID': 'ORDER1',
    'Recipient Name': 'Vendor One',
    'Recipient UEI': 'UEI1',
    'Award Amount': 125,
    'Last Modified Date': '2026-07-01',
    NAICS: { code: '541512' },
    PSC: { code: 'DA01' },
    generated_internal_id: 'CONT_AWD_ORDER1_1234_PARENT1_9999',
  }, {
    'Award ID': 'ORDER2',
    'Recipient Name': 'Vendor Two',
    'Recipient UEI': 'UEI2',
    'Award Amount': 75,
    'Last Modified Date': '2026-07-12',
    NAICS: { code: '541512' },
    PSC: { code: 'R499' },
    generated_internal_id: 'CONT_AWD_ORDER2_1234_PARENT1_9999',
  }]
  assert.equal(parentAwardIdFromRecord(records[0]), 'PARENT1')
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

test('maps and deduplicates direct USAspending agency search results', () => {
  const source = {
    id: 1173,
    toptier_flag: true,
    toptier_agency: { toptier_code: '097', abbreviation: 'DOD', name: 'Department of Defense' },
    subtier_agency: { abbreviation: 'DOD', name: 'Department of Defense' },
  }
  const results = mapOfficialAgencyResults([source, source])

  assert.equal(results.length, 1)
  assert.deepEqual(results[0], {
    id: 1173,
    tier: 'toptier',
    name: 'Department of Defense',
    abbreviation: 'DOD',
    toptierCode: '097',
    parentName: 'Department of Defense',
    parentAbbreviation: 'DOD',
  })
})

test('backfills only department and agency IDs from an unambiguous pulled SAM hierarchy', () => {
  const reference = buildSAMAgencyIdReference([
    { Department: 'DEPT OF DEFENSE', 'Department ID': '097', Agency: 'DEPT OF THE ARMY', 'Agency ID': '2100' },
  ])
  assert.deepEqual(agencyIdPatch({
    'Department*': 'Department of Defense',
    'Agency*': 'Department of Army',
  }, reference), {
    'Department ID': '097',
    'Agency ID': '2100',
  })
})

test('does not backfill an agency ID when the pulled hierarchy is ambiguous', () => {
  const reference = buildSAMAgencyIdReference([
    { Department: 'Example Department', 'Department ID': '001', Agency: 'Example Agency', 'Agency ID': 'A1' },
    { Department: 'Example Department', 'Department ID': '001', Agency: 'Example Agency', 'Agency ID': 'A2' },
  ])
  assert.deepEqual(agencyIdPatch({
    'Department*': 'Example Department',
    'Agency*': 'Example Agency',
  }, reference), {
    'Department ID': '001',
  })
})

test('resolves only an exact agency name or abbreviation under the expected department', () => {
  const agencies = mapOfficialAgencyResults([
    {
      id: 824,
      toptier_flag: false,
      toptier_agency: { toptier_code: '075', abbreviation: 'HHS', name: 'Department of Health and Human Services' },
      subtier_agency: { abbreviation: 'CDC', name: 'Centers for Disease Control and Prevention' },
    },
  ])

  assert.equal(findExactAgencyMatch('CDC', agencies, { parentName: 'Department of Health and Human Services' })?.id, 824)
  assert.equal(findExactAgencyMatch('Disease Control', agencies), null)
  assert.equal(findExactAgencyMatch('CDC', agencies, { parentName: 'Department of Defense' }), null)
})

test('matches a pipeline agency without comparing SAM IDs to USAspending codes', () => {
  const agencies = mapOfficialAgencyResults([
    {
      id: 824,
      toptier_flag: false,
      toptier_agency: { toptier_code: '075', abbreviation: 'HHS', name: 'Department of Health and Human Services' },
      subtier_agency: { abbreviation: 'CDC', name: 'Centers for Disease Control and Prevention' },
    },
  ])

  const match = findPipelineAgencyMatch({
    name: 'Centers for Disease Control and Prevention (CDC)',
    parentName: 'DEPT OF HEALTH AND HUMAN SERVICES',
    departmentId: '7500',
    agencyId: '7523',
  }, agencies)

  assert.equal(match?.id, 824)
  assert.deepEqual(
    pipelineAgencySearchTerms({ name: 'Centers for Disease Control and Prevention (CDC)' }),
    ['Centers for Disease Control and Prevention (CDC)', 'Centers for Disease Control and Prevention', 'CDC'],
  )
  assert.deepEqual(pipelineAgencySearchTerms(), [])
})
