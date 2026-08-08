import test from 'node:test'
import assert from 'node:assert/strict'
import {
  agencyIdPatch,
  buildSAMAgencyIdReference,
} from '../src/lib/agencyIntelligence.js'
import {
  aggregateSamVehicleContracts,
  vehicleFamilyName,
} from '../src/lib/samVehicleIntelligence.js'

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

test('does not backfill an agency ID when the pulled SAM hierarchy is ambiguous', () => {
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

test('consolidates OASIS Plus variants into one named vehicle family', () => {
  assert.equal(vehicleFamilyName({ title: 'OASIS+ Total Small Business', description: '' }), 'OASIS+ (One Acquisition Solution for Integrated Services Plus)')
  assert.equal(vehicleFamilyName({ title: 'OASIS PLUS UNRESTRICTED', description: '' }), 'OASIS+ (One Acquisition Solution for Integrated Services Plus)')
})

test('aggregates SAM contract records and sums each contract total value', () => {
  const contracts = [{
    awardId: 'ORDER1',
    parentAwardId: '47QTCA20D0001',
    parentAgencyId: '4732',
    contractingDepartmentName: 'Department of Health and Human Services',
    awardType: 'DELIVERY ORDER',
    setAside: 'SMALL BUSINESS SET-ASIDE - TOTAL',
    contractor: 'Vendor One',
    totalContractValue: 125000,
    totalObligations: 25000,
  }, {
    awardId: 'ORDER2',
    parentAwardId: '47QTCA20D0001',
    parentAgencyId: '4732',
    contractingDepartmentName: 'Department of Health and Human Services',
    awardType: 'DELIVERY ORDER',
    setAside: '',
    contractor: 'Vendor Two',
    totalContractValue: 75000,
    totalObligations: 10000,
  }]
  const resolutions = {
    '4732|47QTCA20D0001': {
      piid: '47QTCA20D0001',
      agencyId: '4732',
      title: 'GSA Multiple Award Schedule',
      vehicleType: 'INDEFINITE DELIVERY CONTRACT',
      issuingDepartment: 'General Services Administration',
    },
  }
  const result = aggregateSamVehicleContracts(contracts, resolutions)
  assert.equal(result.vehicles.length, 1)
  assert.equal(result.vehicles[0].recordCount, 2)
  assert.equal(result.vehicles[0].totalContractValue, 200000)
  assert.equal(result.totals.totalContractValue, 200000)
})
