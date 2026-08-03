import test from 'node:test'
import assert from 'node:assert/strict'
import {
  agencyIdPatch,
  buildSAMAgencyIdReference,
  findExactAgencyMatch,
  mapOfficialAgencyResults,
} from '../src/lib/agencyIntelligence.js'

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
