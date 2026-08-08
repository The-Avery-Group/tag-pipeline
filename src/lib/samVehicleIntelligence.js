const clean = (value) => String(value ?? '').trim()
const number = (value) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

const GENERIC_VEHICLE_NAMES = /^(?:IDV|IDIQ|IDC|GWAC|FSS|BPA|BOA|REQUIREMENTS? CONTRACT|DEFINITE QUANTITY CONTRACT|INDEFINITE DELIVERY CONTRACT|MULTIPLE AWARD|SINGLE AWARD|CONTRACT)$/i

export function normalizeAgencyKey(value) {
  return clean(value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function samAgencyIdentity(agency = {}) {
  const departmentId = clean(agency.departmentId || agency.samDepartmentId)
  const agencyId = clean(agency.agencyId || agency.samAgencyId)
  const tier = agency.tier === 'department' || (!agencyId && departmentId === agencyId)
    ? 'department'
    : 'subtier'
  return [tier, departmentId, agencyId, normalizeAgencyKey(agency.name)].join(':')
}

export function currentFiveYearWindow(date = new Date()) {
  const end = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
  const start = new Date(Date.UTC(end.getUTCFullYear() - 5, end.getUTCMonth(), end.getUTCDate()))
  const samDate = (value) => `${String(value.getUTCMonth() + 1).padStart(2, '0')}/${String(value.getUTCDate()).padStart(2, '0')}/${value.getUTCFullYear()}`
  return {
    startDate: samDate(start),
    endDate: samDate(end),
    firstYear: start.getUTCFullYear(),
    lastYear: end.getUTCFullYear(),
  }
}

function compactTitle(value) {
  return clean(value)
    .replace(/\s+/g, ' ')
    .replace(/^[\s:;,.\-]+|[\s:;,.\-]+$/g, '')
    .slice(0, 180)
}

export function vehicleFamilyName(resolution = {}, fallback = {}) {
  const piid = clean(resolution.piid || fallback.parentAwardId).toUpperCase()
  const title = compactTitle(resolution.title || resolution.description)
  const haystack = `${title} ${piid}`.toUpperCase()

  const knownFamilies = [
    [/\bOASIS\s*\+|\bOASIS\s+PLUS/, 'OASIS+ (One Acquisition Solution for Integrated Services Plus)'],
    [/\bALLIANT\s*2?\b/, haystack.includes('ALLIANT 2') ? 'Alliant 2' : 'Alliant'],
    [/\bCIO[-\s]?SP4\b/, 'CIO-SP4'],
    [/\bCIO[-\s]?SP3\b/, 'CIO-SP3'],
    [/\bSEWP\s*(?:V|5)\b|\bNASA\s+SEWP\b/, 'NASA SEWP V'],
    [/\b8\s*\(A\)\s+STARS\s*III\b|\bSTARS\s*III\b/, '8(a) STARS III'],
    [/\bPOLARIS\b/, 'Polaris'],
    [/\bHCaTS\b/i, 'HCaTS'],
    [/\bVETS\s*2\b/, 'VETS 2'],
    [/\bASTRO\b/, 'ASTRO'],
  ]
  for (const [pattern, name] of knownFamilies) {
    if (pattern.test(haystack)) return name
  }

  if (/^(?:47QTCA|GS\d{2}F)/.test(piid) || /MULTIPLE AWARD SCHEDULE|FEDERAL SUPPLY SCHEDULE|GSA SCHEDULE/.test(haystack)) {
    return 'GSA Multiple Award Schedule (MAS) / legacy Schedule'
  }
  if (/^(?:36F797|V797)/.test(piid) || /VA FEDERAL SUPPLY SCHEDULE/.test(haystack)) {
    return 'VA Federal Supply Schedule'
  }

  if (title && !GENERIC_VEHICLE_NAMES.test(title)) return title
  return ''
}

function latestDate(left, right) {
  if (!left) return right || ''
  if (!right) return left
  return new Date(right).getTime() > new Date(left).getTime() ? right : left
}

function increment(map, value) {
  const key = clean(value)
  if (key) map.set(key, (map.get(key) || 0) + 1)
}

function mostCommon(map) {
  return [...map.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] || ''
}

function displaySetAside(value) {
  const name = clean(value)
  if (!name) return ''
  if (/NO SET ASIDE|NOT APPLICABLE|NONE/i.test(name)) return 'Unrestricted / no set-aside'
  return name
}

function resolutionFor(resolutions, contract) {
  const exact = `${clean(contract.parentAgencyId).toUpperCase()}|${clean(contract.parentAwardId).toUpperCase()}`
  return resolutions?.[exact] || resolutions?.[clean(contract.parentAwardId).toUpperCase()] || null
}

export function aggregateSamVehicleContracts(contracts = [], resolutions = {}) {
  const families = new Map()
  const seenContracts = new Set()
  let excludedContracts = 0

  for (const source of contracts) {
    const contract = {
      ...source,
      awardId: clean(source.awardId).toUpperCase(),
      parentAwardId: clean(source.parentAwardId).toUpperCase(),
      parentAgencyId: clean(source.parentAgencyId).toUpperCase(),
    }
    if (!contract.awardId || !contract.parentAwardId) {
      excludedContracts += 1
      continue
    }
    const contractKey = `${clean(contract.contractingAgencyId)}|${contract.awardId}|${contract.parentAgencyId}|${contract.parentAwardId}`
    if (seenContracts.has(contractKey)) continue
    seenContracts.add(contractKey)

    const resolution = resolutionFor(resolutions, contract) || {}
    const familyName = vehicleFamilyName(resolution, contract)
    if (!familyName) {
      excludedContracts += 1
      continue
    }

    if (!families.has(familyName)) {
      families.set(familyName, {
        vehicleName: familyName,
        identifiers: new Map(),
        contractors: new Set(),
        orderCount: 0,
        totalContractValue: 0,
        totalObligations: 0,
        lastUsed: '',
        issuingDepartments: new Set(),
        vehicleTypes: new Set(),
        setAsides: new Set(),
        awardTypes: new Set(),
        naics: new Map(),
        psc: new Map(),
        contracts: [],
      })
    }
    const family = families.get(familyName)
    const identifierKey = `${contract.parentAgencyId}|${contract.parentAwardId}`
    if (!family.identifiers.has(identifierKey)) {
      family.identifiers.set(identifierKey, {
        piid: contract.parentAwardId,
        agencyId: contract.parentAgencyId,
        type: clean(resolution.vehicleType || contract.referencedVehicleType),
        issuingDepartment: clean(resolution.issuingDepartment || contract.parentAgencyName),
        contractValue: number(resolution.totalContractValue),
        lastDateToOrder: clean(resolution.lastDateToOrder),
        orderCount: 0,
      })
    }
    family.identifiers.get(identifierKey).orderCount += 1
    const issuingDepartment = clean(resolution.issuingDepartment || contract.parentAgencyName)
    const vehicleType = clean(resolution.vehicleType || contract.referencedVehicleType)
    const setAside = displaySetAside(resolution.setAside || contract.setAside)
    const awardType = clean(contract.awardType)
    if (issuingDepartment) family.issuingDepartments.add(issuingDepartment)
    if (vehicleType) family.vehicleTypes.add(vehicleType)
    if (setAside) family.setAsides.add(setAside)
    if (awardType) family.awardTypes.add(awardType)
    if (clean(contract.contractor)) family.contractors.add(clean(contract.contractor))
    family.orderCount += 1
    family.totalContractValue += number(contract.totalContractValue)
    family.totalObligations += number(contract.totalObligations)
    family.lastUsed = latestDate(family.lastUsed, contract.dateSigned || contract.lastModifiedDate)
    increment(family.naics, contract.naicsCode)
    increment(family.psc, contract.pscCode)
    if (family.contracts.length < 500) {
      family.contracts.push({
        awardId: contract.awardId,
        contractor: clean(contract.contractor),
        contractorUEI: clean(contract.contractorUEI),
        title: compactTitle(contract.title || contract.description),
        awardType: clean(contract.awardType),
        setAside: displaySetAside(contract.setAside),
        totalContractValue: number(contract.totalContractValue),
        totalObligations: number(contract.totalObligations),
        dateSigned: clean(contract.dateSigned),
        parentAwardId: contract.parentAwardId,
      })
    }
  }

  const vehicles = [...families.values()].map((family) => ({
    vehicleName: family.vehicleName,
    identifiers: [...family.identifiers.values()].sort((a, b) => b.orderCount - a.orderCount || a.piid.localeCompare(b.piid)),
    identifierCount: family.identifiers.size,
    recordCount: family.orderCount,
    contractors: family.contractors.size,
    orderCount: family.orderCount,
    issuingDepartments: [...family.issuingDepartments].sort(),
    vehicleTypes: [...family.vehicleTypes].sort(),
    setAsides: [...family.setAsides].sort(),
    awardTypes: [...family.awardTypes].sort(),
    totalContractValue: family.totalContractValue,
    totalObligations: family.totalObligations,
    lastUsed: family.lastUsed,
    topNaics: mostCommon(family.naics),
    topPsc: mostCommon(family.psc),
    contracts: family.contracts.sort((a, b) => new Date(b.dateSigned).getTime() - new Date(a.dateSigned).getTime()),
  })).sort((a, b) => b.orderCount - a.orderCount || b.totalContractValue - a.totalContractValue || a.vehicleName.localeCompare(b.vehicleName))

  return {
    vehicles,
    totals: {
      vehicleFamilies: vehicles.length,
      identifiers: vehicles.reduce((sum, vehicle) => sum + vehicle.identifierCount, 0),
      contracts: vehicles.reduce((sum, vehicle) => sum + vehicle.orderCount, 0),
      contractors: new Set(vehicles.flatMap((vehicle) => vehicle.contracts.map((contract) => contract.contractor).filter(Boolean))).size,
      totalContractValue: vehicles.reduce((sum, vehicle) => sum + vehicle.totalContractValue, 0),
      totalObligations: vehicles.reduce((sum, vehicle) => sum + vehicle.totalObligations, 0),
    },
    excludedContracts,
  }
}
