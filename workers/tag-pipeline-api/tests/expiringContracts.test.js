import assert from 'node:assert/strict'
import test from 'node:test'
import {
  contractEligibility,
  expiringHiddenKey,
  fetchAgencyModifierNotices,
  fetchExpiringAwardsPage,
  isExcludedExpiringSetAside,
  matchingModifierContacts,
  modifierNoticeWindows,
  noticeContacts,
  normalizeExpiringAgency,
  resolveExpiringAgencies,
  resolveLastModifiedBy,
  runExpiringContractsRefresh,
  startExpiringContractsRefresh,
  summarizeAwardFamily,
} from '../src/handlers/expiringContracts.js'
import { solicitationFamily } from '../src/handlers/sam.js'
import {
  DEFAULT_CONTRACT_VEHICLE_RULES,
  mergeContractVehicleRules,
  parseVehicleIdentifier,
  resolveContractVehicle,
} from '../src/lib/contractVehicleResolver.js'

function award({
  modificationNumber = '0',
  reasonCode = '',
  reasonName = '',
  dateSigned = '2026-01-01',
  currentCompletionDate = '2027-08-01',
  ultimateCompletionDate = '2028-02-01',
  lastModifiedBy = 'HHSAHAYNES',
  setAside = '',
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
      competitionInformation: { typeOfSetAside: setAside ? { name: setAside } : null },
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

test('contract vehicle identifiers normalize modern PIID components', () => {
  assert.deepEqual(parseVehicleIdentifier('47QTCK-18-D-0047'), {
    normalized: '47QTCK18D0047',
    legacy: false,
    aac: '47QTCK',
    fiscalYear: '18',
    instrument: 'D',
    serial: '0047',
  })
})

test('vehicle rules resolve verified patterns and exact legacy rosters without an API fallback', () => {
  const alliant = resolveContractVehicle('47QTCK18D0047', DEFAULT_CONTRACT_VEHICLE_RULES)
  assert.equal(alliant.status, 'RESOLVED')
  assert.equal(alliant.vehicleName, 'Alliant 2')
  assert.equal(alliant.resolutionMethod, 'PATTERN')

  const sewp = resolveContractVehicle('NNG15SD19B', DEFAULT_CONTRACT_VEHICLE_RULES)
  assert.equal(sewp.status, 'RESOLVED')
  assert.equal(sewp.vehicleName, 'NASA SEWP V')
  assert.equal(sewp.resolutionMethod, 'EXACT_ROSTER')

  const shield = resolveContractVehicle('HQ085926DG111', DEFAULT_CONTRACT_VEHICLE_RULES)
  assert.equal(shield.status, 'RESOLVED')
  assert.equal(shield.vehicleName, 'SHIELD')
  assert.equal(shield.confidence, 'ASSUMED_HIGH')

  const unknown = resolveContractVehicle('W52P1J26D9999', DEFAULT_CONTRACT_VEHICLE_RULES)
  assert.equal(unknown.status, 'UNRESOLVED')
  assert.equal(unknown.reason, 'No enabled workbook rule matched')
})

test('legacy and agency-specific IDVs resolve to useful researched names', () => {
  const expected = new Map([
    ['HHSN316201500053W', 'CIO-CS'],
    ['47QTCA18D0081', 'GSA MAS'],
    ['36C10A22D0003', 'National Dialysis EHR IDIQ'],
    ['36C26324D0074', 'VISN 23 Project Support Services IDIQ'],
    ['GS03F071DA', 'GSA MAS'],
    ['VA11816D1001', 'T4NG'],
    ['W912CH26D0017', 'PEO CSCSS Engineering Support IDIQ'],
    ['HC105023D0004', 'JWCC'],
    ['47QRAD20D8108', 'OASIS'],
  ])
  for (const [identifier, vehicle] of expected) {
    assert.equal(resolveContractVehicle(identifier, DEFAULT_CONTRACT_VEHICLE_RULES).vehicleName, vehicle)
  }
})

test('priority-agency cache families resolve through reusable cohort rules', () => {
  const expected = new Map([
    ['HHSN316201200025W', 'CIO-SP3'],
    ['HHSN316201500041W', 'CIO-CS'],
    ['GS35F0207P', 'GSA MAS'],
    ['GS00F123DA', 'GSA MAS'],
    ['GS00Q14OADU142', 'OASIS'],
    ['47QRAD20D1207', 'OASIS'],
    ['47QRAD20D8110', 'OASIS'],
    ['VA11816D1015', 'T4NG'],
    ['HC105023D0002', 'JWCC'],
    ['HC105023D0005', 'JWCC'],
  ])
  for (const [identifier, vehicle] of expected) {
    assert.equal(resolveContractVehicle(identifier, DEFAULT_CONTRACT_VEHICLE_RULES).vehicleName, vehicle)
  }
  assert.equal(resolveContractVehicle('GS00Q14OADU142', DEFAULT_CONTRACT_VEHICLE_RULES).vehicleVariant, 'Unrestricted')
  assert.equal(resolveContractVehicle('47QRAD20D1207', DEFAULT_CONTRACT_VEHICLE_RULES).vehicleVariant, 'Small Business')
  assert.equal(resolveContractVehicle('47QRAD20D8110', DEFAULT_CONTRACT_VEHICLE_RULES).vehicleVariant, '8(a)')
})

test('priority-agency named vehicle cohorts resolve without AI or runtime API calls', () => {
  const expected = new Map([
    ['75N98120D00149', 'CIO-SP3'],
    ['75N95021D00012', 'NIH SOAR'],
    ['75N93019D00026', 'NIAID Professional, Scientific, and Technical Support Services'],
    ['75N99020D00008', 'NIH Architect-Engineering MATOC'],
    ['DEAM3609GO29039', 'DOE ESPC Gen2'],
    ['HS002120D0002', 'DCSA Administrative Support Services'],
    ['HS002124DE001', 'DCSA Communication Operations Support'],
    ['HT942523D0002', 'DHA MPASS'],
    ['W912DQ21D3005', 'USACE Kansas City HTRW 2021 MATOC'],
    ['W912QR21D0073', 'USACE AFRC Nationwide A/E MATOC'],
    ['W912QR21D0026', 'USACE Army Reserve A/E IDIQ'],
    ['80ARC018D0010', 'NASA Advanced Computing Services'],
    ['80JSC021AA001', 'NASA COMPES II'],
    ['80JSC025D0071', 'NASA SASS II'],
    ['80NSSC23DA002', 'NASA Enterprise-wide Human Capital Support Services'],
  ])
  for (const [identifier, vehicle] of expected) {
    assert.equal(resolveContractVehicle(identifier, DEFAULT_CONTRACT_VEHICLE_RULES).vehicleName, vehicle)
  }

  assert.equal(resolveContractVehicle('75N98120D00149', DEFAULT_CONTRACT_VEHICLE_RULES).resolutionMethod, 'FULL_PIID_PATTERN')
  assert.equal(resolveContractVehicle('W912DQ21D3010', DEFAULT_CONTRACT_VEHICLE_RULES).status, 'UNRESOLVED')
  assert.equal(resolveContractVehicle('W912QR21D0074', DEFAULT_CONTRACT_VEHICLE_RULES).status, 'UNRESOLVED')
})

test('official solicitation rosters resolve target-agency IDVs beyond the current cache', () => {
  const expected = new Map([
    ['36C10B21D1029', 'T4NG'],
    ['36C10X23D0042', 'VECTOR'],
    ['36C10F23D0014', 'CFM National Region A/E IDIQ'],
    ['36C77625D0026', 'VA National A/E IDIQ MATOC'],
    ['80NSSC23DA001', 'NASA Enterprise-wide Human Capital Support Services'],
    ['80JSC025D0065', 'NASA Open Innovation Services 3'],
    ['W900KK24D0022', 'Mission Training Complex Capabilities Support II'],
  ])
  for (const [identifier, vehicle] of expected) {
    assert.equal(resolveContractVehicle(identifier, DEFAULT_CONTRACT_VEHICLE_RULES).vehicleName, vehicle)
  }

  assert.equal(resolveContractVehicle('36C10X23D0043', DEFAULT_CONTRACT_VEHICLE_RULES).status, 'UNRESOLVED')
  assert.equal(resolveContractVehicle('80JSC025D0068', DEFAULT_CONTRACT_VEHICLE_RULES).status, 'UNRESOLVED')
})

test('an incomplete workbook cannot suppress verified built-in vehicle rules', () => {
  const workbookRules = [
    {
      RULE_ID: 'gsa-mas-47qraa', VEHICLE_NAME: 'GSA MAS', MATCH_MODE: '', AAC: '',
      FY_RULE_TYPE: '', FY_RULE: '', INSTRUMENT_CODE: '', SERIAL_RULE_TYPE: '',
      SERIAL_RULE: '', PRIORITY: '', CONFIDENCE: '', ENABLED: '',
    },
    {
      RULE_ID: 'nih-soar-2021-cohort', VEHICLE_NAME: 'NIH SOAR', MATCH_MODE: 'COMPONENTS',
      AAC: '75N950', FY_RULE_TYPE: 'EXACT', FY_RULE: 21, INSTRUMENT_CODE: 'D',
      SERIAL_RULE_TYPE: 'SET', SERIAL_RULE: 12, PRIORITY: 500, ENABLED: 'Yes',
    },
    {
      RULE_ID: 'manual-example', VEHICLE_NAME: 'Example Vehicle', MATCH_MODE: 'FULL_PIID',
      FULL_PIID_RULE_TYPE: 'EXACT', FULL_PIID_RULE: 'ABCDEF26D0001',
      PRIORITY: 900, CONFIDENCE: 'MANUAL', ENABLED: 'Yes',
    },
  ]
  const effectiveRules = mergeContractVehicleRules(workbookRules)

  assert.equal(resolveContractVehicle('47QRAA20D0068', effectiveRules).vehicleName, 'GSA MAS')
  assert.equal(resolveContractVehicle('75N95021D00012', effectiveRules).vehicleName, 'NIH SOAR')
  assert.equal(resolveContractVehicle('W912QR21D0073', effectiveRules).vehicleName, 'USACE AFRC Nationwide A/E MATOC')
  assert.equal(resolveContractVehicle('ABCDEF26D0001', effectiveRules).vehicleName, 'Example Vehicle')
})

test('the workbook can explicitly disable a verified built-in vehicle rule', () => {
  const effectiveRules = mergeContractVehicleRules([{
    RULE_ID: 'gsa-mas-47qraa', VEHICLE_NAME: 'GSA MAS', ENABLED: 'No',
  }])
  assert.equal(resolveContractVehicle('47QRAA18D006J', effectiveRules).status, 'UNRESOLVED')
})

test('specific vehicle rules take precedence over broad MAS fallback rules', () => {
  const result = resolveContractVehicle('47QSHA18D0005', DEFAULT_CONTRACT_VEHICLE_RULES)
  assert.equal(result.status, 'RESOLVED')
  assert.equal(result.vehicleName, 'BMO Unrestricted Phase 2')

  const mas = resolveContractVehicle('47QSHA18D000D', DEFAULT_CONTRACT_VEHICLE_RULES)
  assert.equal(mas.status, 'RESOLVED')
  assert.equal(mas.vehicleName, 'GSA MAS')

  const collisionSafeUnknown = resolveContractVehicle('47QSHA18D0040', DEFAULT_CONTRACT_VEHICLE_RULES)
  assert.equal(collisionSafeUnknown.status, 'UNRESOLVED')
})

test('equal-strength conflicting rules stay unresolved instead of guessing', () => {
  const base = {
    MATCH_MODE: 'COMPONENTS', AAC: 'ABCDEF', FY_RULE_TYPE: 'EXACT', FY_RULE: '26',
    INSTRUMENT_CODE: 'D', SERIAL_RULE_TYPE: 'ANY', SERIAL_RULE: '', PRIORITY: 100,
    ENABLED: 'Yes', CONFIDENCE: 'MANUAL',
  }
  const result = resolveContractVehicle('ABCDEF26D0001', [
    { ...base, RULE_ID: 'one', VEHICLE_NAME: 'Vehicle One' },
    { ...base, RULE_ID: 'two', VEHICLE_NAME: 'Vehicle Two' },
  ])
  assert.equal(result.status, 'UNRESOLVED_CONFLICT')
  assert.equal(result.matches.length, 2)
})

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

test('women-owned and HUBZone set-asides are excluded from expiring discovery', () => {
  assert.equal(isExcludedExpiringSetAside('Women-Owned Small Business (WOSB) Program Set-Aside'), true)
  assert.equal(isExcludedExpiringSetAside('Economically Disadvantaged Women-Owned Small Business (EDWOSB)'), true)
  assert.equal(isExcludedExpiringSetAside('HUBZone Set-Aside'), true)
  assert.equal(isExcludedExpiringSetAside('8(a) Set-Aside'), false)
  assert.equal(isExcludedExpiringSetAside('Total Small Business Set-Aside'), false)
})

test('excluded set-asides are discarded before an award page enters the refresh checkpoint', async () => {
  const previousFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({
    totalRecords: 3,
    awardSummary: [
      award({ setAside: 'WOSB Set-Aside' }),
      award({ modificationNumber: '1', setAside: 'HUBZone Set-Aside' }),
      award({ modificationNumber: '2', setAside: '8(a) Set-Aside' }),
    ],
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  try {
    const result = await fetchExpiringAwardsPage({ SAM_API_KEY: 'test-key' }, {
      agency: { id: 'cdc', searchName: 'CDC', tier: 'subtier' },
      naicsCodes: ['541611'],
      now: new Date('2026-08-12T00:00:00Z'),
    })
    assert.equal(result.records.length, 1)
    assert.equal(result.records[0].coreData.competitionInformation.typeOfSetAside.name, '8(a) Set-Aside')
    assert.equal(result.nextOffset, 3)
  } finally {
    globalThis.fetch = previousFetch
  }
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
    return new Response(JSON.stringify({ totalRecords: 1, awardSummary: [award()] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
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
    assert.equal(params.has('typeOfSetAsideCode'), false)
  } finally {
    globalThis.fetch = previousFetch
  }
})

test('an empty code result retries the same official agency by name', async () => {
  const previousFetch = globalThis.fetch
  const requestUrls = []
  globalThis.fetch = async (url) => {
    requestUrls.push(String(url))
    if (new URL(url).searchParams.has('contractingSubtierCode')) return new Response(null, { status: 204 })
    return new Response(JSON.stringify({ totalRecords: 1, awardSummary: [award()] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  try {
    const result = await fetchExpiringAwardsPage({ SAM_API_KEY: 'test-key' }, {
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
    assert.equal(requestUrls.length, 2)
    assert.equal(new URL(requestUrls[0]).searchParams.get('contractingSubtierCode'), '9700')
    assert.equal(new URL(requestUrls[1]).searchParams.get('contractingSubtierName'), 'DEFENSE HEALTH AGENCY')
    assert.equal(result.filter, 'name-fallback')
    assert.equal(result.total, 1)
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

test('modifier notice windows merge nearby modification dates into one bounded search', () => {
  const windows = modifierNoticeWindows([
    { lastModifiedDate: '2026-06-01' },
    { dateSigned: '2026-06-20' },
    { lastModifiedDate: '2025-01-01' },
  ])
  assert.equal(windows.length, 2)
  assert.equal(windows[0].from.toISOString().slice(0, 10), '2024-12-02')
  assert.equal(windows[1].from.toISOString().slice(0, 10), '2026-05-02')
  assert.equal(windows[1].to.toISOString().slice(0, 10), '2026-07-20')
})

test('agency-date POC fallback searches award and opportunity notices together', async () => {
  const previousFetch = globalThis.fetch
  let requestUrl = ''
  globalThis.fetch = async (url) => {
    requestUrl = String(url)
    return new Response(JSON.stringify({
      opportunitiesData: [{
        noticeId: 'award-notice-1',
        title: 'Award notice',
        type: 'Award Notice',
        postedDate: '2026-06-15',
        pointOfContact: [{ fullName: 'Amanda Haynes', email: 'amanda.haynes@hhs.gov' }],
      }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }
  try {
    const notices = await fetchAgencyModifierNotices({ SAM_API_KEY: 'test-key' }, {
      agencyCode: '7523',
      agencyName: 'CENTERS FOR DISEASE CONTROL AND PREVENTION',
      modifications: [{ lastModifiedDate: '2026-06-10' }],
    })
    const params = new URL(requestUrl).searchParams
    assert.equal(params.get('organizationCode'), '7523')
    assert.equal(params.get('limit'), '1000')
    assert.deepEqual(params.getAll('ptype'), ['a', 'r', 'o', 'k', 'p', 's'])
    assert.equal(notices.length, 1)
    const contacts = noticeContacts(notices, 'CENTERS FOR DISEASE CONTROL AND PREVENTION')
    assert.equal(contacts[0].sourceLabel, 'SAM award notice')
    assert.equal(resolveLastModifiedBy('HHSAHAYNES', 'CENTERS FOR DISEASE CONTROL AND PREVENTION', contacts).status, 'matched')
  } finally {
    globalThis.fetch = previousFetch
  }
})

test('agency-date POC fallback retries by agency name when its code returns no notices', async () => {
  const previousFetch = globalThis.fetch
  const requests = []
  globalThis.fetch = async (url) => {
    requests.push(String(url))
    if (new URL(url).searchParams.has('organizationCode')) return new Response(null, { status: 204 })
    return new Response(JSON.stringify({ opportunitiesData: [{ noticeId: 'fallback-1', type: 'Solicitation', postedDate: '2026-06-01' }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  try {
    const notices = await fetchAgencyModifierNotices({ SAM_API_KEY: 'test-key' }, {
      agencyCode: '7523',
      agencyName: 'CENTERS FOR DISEASE CONTROL AND PREVENTION',
      modifications: [{ dateSigned: '2026-06-01' }],
    })
    assert.equal(requests.length, 2)
    assert.equal(new URL(requests[1]).searchParams.get('organizationName'), 'CENTERS FOR DISEASE CONTROL AND PREVENTION')
    assert.equal(notices.length, 1)
  } finally {
    globalThis.fetch = previousFetch
  }
})

test('agency-wide POC fallback retains only contacts matching a modifier identity', () => {
  const contacts = [
    { name: 'Amanda Haynes', email: 'amanda.haynes@hhs.gov', sourceLabel: 'SAM award notice' },
    { name: 'Unrelated Person', email: 'unrelated@hhs.gov', sourceLabel: 'SAM opportunity notice' },
  ]
  const matches = matchingModifierContacts(contacts, [{ lastModifiedBy: 'HHSAHAYNES' }], 'CENTERS FOR DISEASE CONTROL AND PREVENTION')
  assert.equal(matches.length, 1)
  assert.equal(matches[0].name, 'Amanda Haynes')
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

test('default agencies inherit official codes from their previous cached award results', async () => {
  let created
  const values = new Map([
    ['expiring_contracts:data:v1:cdc', JSON.stringify({
      official: {
        departmentCode: '7500',
        agencyCode: '7523',
        agencyName: 'CENTERS FOR DISEASE CONTROL AND PREVENTION',
        departmentName: 'HEALTH AND HUMAN SERVICES, DEPARTMENT OF',
      },
    })],
  ])
  const env = {
    CACHE: {
      async get(key, type) {
        const value = values.get(key)
        return type === 'json' && value ? JSON.parse(value) : value || null
      },
      async put(key, value) { values.set(key, value) },
    },
    EXPIRING_CONTRACTS_WORKFLOW: {
      async createBatch(batch) { created = batch; return [{ id: batch[0].id }] },
    },
  }
  await startExpiringContractsRefresh(env, {
    agencies: [{ id: 'cdc', label: 'CDC', searchName: 'CENTERS FOR DISEASE CONTROL AND PREVENTION', tier: 'subtier' }],
    scheduledTime: Date.parse('2026-08-12T00:00:00Z'),
  })
  assert.equal(created[0].params.agencies[0].agencyCode, '7523')
  const registry = JSON.parse(values.get('expiring_contracts:agency_registry:v1'))
  assert.equal(registry.find((agency) => agency.id === 'cdc').agencyCode, '7523')
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

    assert.equal(fetchCount, 3)
    assert.equal(result.status, 'continuing')
    assert.equal(result.nextCheckpoint, 2)
    assert.equal(created[0].params.continuation.pageNumber, 3)
    assert.equal(created[0].params.continuation.offset, 300)
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
