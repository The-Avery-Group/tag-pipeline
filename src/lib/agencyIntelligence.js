function clean(value) {
  return String(value || '').trim()
}

export function mapOfficialAgency(result) {
  const top = result?.toptier_agency || {}
  const sub = result?.subtier_agency || {}
  const tier = result?.toptier_flag ? 'toptier' : 'subtier'
  return {
    id: result?.id ?? null,
    tier,
    name: clean(tier === 'toptier' ? top.name : sub.name),
    abbreviation: clean(tier === 'toptier' ? top.abbreviation : sub.abbreviation),
    toptierCode: clean(top.toptier_code),
    parentName: clean(top.name),
    parentAbbreviation: clean(top.abbreviation),
  }
}

export function mapOfficialAgencyResults(results = []) {
  const seen = new Set()
  return results.map(mapOfficialAgency).filter((agency) => {
    const key = `${agency.tier}:${agency.toptierCode}:${agency.name.toLowerCase()}`
    if (!agency.name || seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export function normalizeAgencyIdentity(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\bdept\b/g, 'department')
    .replace(/\bthe\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

export function findExactAgencyMatch(query, agencies = [], { tier, parentName } = {}) {
  const target = normalizeAgencyIdentity(query)
  const parent = normalizeAgencyIdentity(parentName)
  if (!target) return null
  return agencies.find((agency) => {
    if (tier && agency.tier !== tier) return false
    if (parent && agency.tier === 'subtier' && normalizeAgencyIdentity(agency.parentName) !== parent) return false
    return normalizeAgencyIdentity(agency.name) === target || normalizeAgencyIdentity(agency.abbreviation) === target
  }) || null
}

export function pipelineAgencySearchTerms(candidate = {}) {
  const name = clean(candidate.name)
  const parentName = clean(candidate.parentName)
  if (!name && !parentName) return []
  const withoutParenthetical = name.replace(/\s*\([^)]*\)\s*/g, ' ').replace(/\s+/g, ' ').trim()
  const parenthetical = [...name.matchAll(/\(([^)]+)\)/g)].map((match) => clean(match[1]))
  return [...new Set([name, withoutParenthetical, ...parenthetical, parentName].filter(Boolean))]
}

/**
 * Match a pipeline agency to an official USAspending agency without treating
 * SAM hierarchy identifiers as USAspending codes. The two systems use
 * different identifier namespaces, so names, abbreviations, tier, and parent
 * agency are the safe common identity fields.
 */
export function findPipelineAgencyMatch(candidate = {}, agencies = []) {
  const name = clean(candidate.name)
  const parentName = clean(candidate.parentName)
  const isSubtier = Boolean(parentName) && normalizeAgencyIdentity(name) !== normalizeAgencyIdentity(parentName)
  const aliases = pipelineAgencySearchTerms({ name }).filter((term) => term !== parentName)

  for (const alias of aliases) {
    const match = findExactAgencyMatch(alias, agencies, {
      tier: isSubtier ? 'subtier' : 'toptier',
      parentName: isSubtier ? parentName : '',
    })
    if (match) return match
  }
  return null
}

function uniqueValue(map, key, value) {
  if (!key || !value) return
  const values = map.get(key) || new Set()
  values.add(String(value).trim())
  map.set(key, values)
}

export function buildSAMAgencyIdReference(rows = []) {
  const departments = new Map()
  const agencies = new Map()
  rows.forEach((row) => {
    const department = normalizeAgencyIdentity(row?.Department)
    const agency = normalizeAgencyIdentity(row?.Agency)
    uniqueValue(departments, department, row?.['Department ID'])
    uniqueValue(agencies, `${department}:${agency}`, row?.['Agency ID'])
  })
  return { departments, agencies }
}

function only(values) {
  return values?.size === 1 ? [...values][0] : ''
}

export function agencyIdPatch(opportunity, reference) {
  const department = normalizeAgencyIdentity(opportunity?.['Department*'])
  const agency = normalizeAgencyIdentity(opportunity?.['Agency*'] || opportunity?.['Department*'])
  const departmentId = only(reference?.departments?.get(department))
  const agencyId = only(reference?.agencies?.get(`${department}:${agency}`))
  const patch = {}
  if (departmentId && String(opportunity?.['Department ID'] || '') !== departmentId) patch['Department ID'] = departmentId
  if (agencyId && String(opportunity?.['Agency ID'] || '') !== agencyId) patch['Agency ID'] = agencyId
  return patch
}
