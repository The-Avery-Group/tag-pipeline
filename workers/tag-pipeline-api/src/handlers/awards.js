/**
 * awards.js — SAM.gov Contract Awards API lookup handler
 *
 * Routes:
 *   GET /awards/lookup?piid=X&solicitationID=Y   (either or both — both are
 *     fired as parallel calls and merged, since a single text input from the
 *     user could be either identifier type and there's no reliable way to
 *     tell which without asking)
 *
 * Auth: reuses env.SAM_API_KEY — the same "Public API Key" already used for
 * the Opportunities pull (sam.js). SAM.gov's Public API Key is account-wide,
 * not per-API, so no new secret was needed.
 *
 * A "Contract Vehicle Number" search is just a PIID search where the
 * matching record happens to be an IDV — there's no separate vehicle
 * parameter in this API, so it's handled by the same `piid` param.
 *
 * Modification history: a PIID query returns every modification of that
 * contract as separate records (modificationNumber is a separate, optional
 * filter — omitting it returns the whole family). A given mod frequently
 * only carries the fields it actually changed (e.g. a funding-only action),
 * leaving everything else blank on that record rather than restating the
 * whole contract. This handler fetches the full family, sorts it
 * chronologically, and deep-merges it into one composite "current state"
 * record — see groupAndMergeByPiid/mergeAwardRecord — so callers always get
 * the latest value for every field without losing anything an earlier mod
 * (or the base award) set and a later mod simply didn't touch.
 *
 * Results are lightly cached in KV (24h) keyed by the exact query, since
 * award data doesn't change minute-to-minute and this shares its 1,000/day
 * quota with the Opportunities pull.
 */

const AWARDS_BASE = 'https://api.sam.gov/contract-awards/v1/search'
const CACHE_TTL_SECONDS = 24 * 60 * 60
const PAGE_SIZE = 100          // API max per page
const MAX_PAGES = 4            // bounds worst-case subrequest cost for a pathologically heavily-modified IDIQ

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

// ── Merge across modification history ───────────────────────────────────
// A contract's award record isn't one static object — every modification
// (funding change, PoP extension, admin correction, etc.) is its own
// transaction, and per SAM's own documented example values (e.g. a mod
// reasonForModification of "FUNDING ONLY ACTION"), a given mod frequently
// only carries the specific fields it changed, leaving everything else
// null/blank on that record rather than restating the whole contract.
// Naively using "the latest mod" would silently lose data that only the
// base award or an earlier mod had. Instead: fetch the whole family for a
// PIID, sort oldest → newest, and deep-merge so later non-null values win
// but nothing is lost where a later record simply didn't touch a field.

function isPlainObject(val) {
  return val !== null && typeof val === 'object' && !Array.isArray(val)
}

function mergeAwardRecord(base, newer) {
  if (!isPlainObject(base)) return newer ?? base
  if (!isPlainObject(newer)) return base
  const result = { ...base }
  for (const key of Object.keys(newer)) {
    const newVal = newer[key]
    if (newVal === null || newVal === undefined || newVal === '') continue   // keep base's value
    const baseVal = base[key]
    result[key] = (isPlainObject(newVal) && isPlainObject(baseVal))
      ? mergeAwardRecord(baseVal, newVal)
      : newVal   // newer non-null scalar/array wins wholesale
  }
  return result
}

function recordDate(r) {
  return new Date(
    r?.awardDetails?.transactionData?.lastModifiedDate ||
    r?.awardDetails?.transactionData?.approvedDate ||
    r?.awardDetails?.dates?.dateSigned || 0
  )
}

// Groups raw records by PIID (scoped by contracting subtier, in case the
// same PIID string were ever reused across subtiers), sorts each group
// chronologically, and folds it into one composite "current state" record.
function groupAndMergeByPiid(records) {
  const groups = new Map()
  for (const r of records) {
    const key = `${r?.contractId?.subtier?.code || ''}:${r?.contractId?.piid || ''}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(r)
  }

  const merged = []
  for (const group of groups.values()) {
    const sorted = [...group].sort((a, b) => recordDate(a) - recordDate(b))
    let composite = sorted[0]
    for (let i = 1; i < sorted.length; i++) composite = mergeAwardRecord(composite, sorted[i])
    merged.push({
      composite,
      matchedBy: sorted[sorted.length - 1]._matchedBy,
      modificationCount: sorted.length,
      latestModificationNumber: sorted[sorted.length - 1]?.contractId?.modificationNumber || null,
    })
  }
  return merged
}

// ── Field extraction ────────────────────────────────────────────────────
// Pulls out exactly the fields TAG's pipeline can actually use (per the
// confirmed column mapping), so the frontend doesn't need to know the raw
// API's deeply nested shape. Each entry also carries the PipelineTable
// column it maps to, so the per-field "update this in the pipeline" button
// can be built generically from this list rather than hardcoded per field.
function extractMappedFields(record) {
  const naics = record?.coreData?.productOrServiceInformation?.principalNaics?.[0]
  const dept  = record?.coreData?.federalOrganization?.contractingInformation?.contractingDepartment
  const subtier = record?.coreData?.federalOrganization?.contractingInformation?.contractingSubtier
  const office   = record?.coreData?.federalOrganization?.contractingInformation?.contractingOffice
  const setAside = record?.coreData?.competitionInformation?.typeOfSetAside
  const awardeeHeader = record?.awardDetails?.awardeeData?.awardeeHeader
  const awardeeUEI    = record?.awardDetails?.awardeeData?.awardeeUEIInformation

  return {
    totalContractValue: { value: record?.awardDetails?.dollars?.baseAndAllOptionsValue ?? null, column: 'Total Contract Value ($)*' },
    contractEndDate:    { value: record?.awardDetails?.dates?.ultimateCompletionDate ?? null,    column: 'Contract End Date*' },
    fiscalYear:         { value: record?.awardDetails?.dates?.fiscalYear ?? null,                 column: 'Fiscal Year' },
    naicsCode:          { value: naics?.code ?? null,                                             column: 'NAICS Code*' },
    department:         { value: dept?.name ?? null,                                              column: 'Department*' },
    agency:             { value: subtier?.name ?? null,                                           column: 'Agency*' },
    office:             { value: office?.name ?? null,                                            column: 'Office*' },
    solicitationNumber: { value: record?.coreData?.solicitationId ?? null,                        column: 'Solicitation Number' },
    setAside:           { value: setAside?.name ?? null,                                          column: 'Set- Aside*' },
    incumbentName:      { value: awardeeHeader?.awardeeName ?? null,                               column: 'Incumbent (Company Name)' },
    incumbentUEI:       { value: awardeeUEI?.uniqueEntityId ?? null,                                column: 'Incumbent (Company UEI)' },
    // Only meaningful on order/call records that actually reference a parent
    // vehicle — null on a record that IS itself a vehicle (IDV).
    contractVehicleNumber: { value: record?.contractId?.referencedIDVPiid ?? null,                 column: 'Contract Vehicle Number' },
  }
}

async function fetchAwards(env, params) {
  const records = []
  let offset = 0

  for (let page = 0; page < MAX_PAGES; page++) {
    const qs = new URLSearchParams({
      api_key: env.SAM_API_KEY, ...params,
      limit: String(PAGE_SIZE), offset: String(offset),
    })
    const res = await fetch(`${AWARDS_BASE}?${qs}`)

    if (res.status === 204) break   // "No Content Found" — not an error, just no (more) matches
    if (!res.ok) {
      const body = await res.text()
      throw new Error(`Awards API error ${res.status}: ${body.slice(0, 300)}`)
    }

    const data = await res.json()
    const page_records = data.awardSummary || []
    records.push(...page_records)

    const total = data.totalRecords ?? page_records.length
    offset += PAGE_SIZE
    if (offset >= total || page_records.length < PAGE_SIZE) break   // no more pages
  }

  return records
}

async function getCached(env, key) {
  if (!env.CACHE) return null
  return env.CACHE.get(key, 'json')
}
async function setCached(env, key, value) {
  if (!env.CACHE) return
  await env.CACHE.put(key, JSON.stringify(value), { expirationTtl: CACHE_TTL_SECONDS })
}

// ── Lookup handler ───────────────────────────────────────────────────────

async function handleLookup(req, env) {
  if (!env.SAM_API_KEY) return json({ error: 'SAM_API_KEY not configured' }, 503)

  const url = new URL(req.url)
  const piid           = url.searchParams.get('piid')?.trim()
  const solicitationID = url.searchParams.get('solicitationID')?.trim()

  if (!piid && !solicitationID) {
    return json({ error: 'Provide at least one of: piid, solicitationID' }, 400)
  }

  const cacheKey = `awards_lookup:${piid || ''}:${solicitationID || ''}`
  const cached = await getCached(env, cacheKey)
  if (cached) return json({ ...cached, cached: true })

  try {
    // Fire whichever queries have a value, in parallel — this is how a
    // single ambiguous user-entered identifier (Lookup tab) gets resolved
    // without asking the user which type they typed. OpportunityDetail's
    // auto-lookup only ever sends `piid`, so only one call fires there.
    // Each call already pages through the FULL modification history for
    // whatever it matches (fetchAwards), not just the first page.
    const calls = []
    if (piid)           calls.push(fetchAwards(env, { piid }).then((r) => r.map((x) => ({ ...x, _matchedBy: 'piid' }))))
    if (solicitationID) calls.push(fetchAwards(env, { solicitationID }).then((r) => r.map((x) => ({ ...x, _matchedBy: 'solicitationID' }))))

    const resultSets = await Promise.all(calls)
    const allRecords = resultSets.flat()

    // Group by PIID (folding every modification of the same contract
    // together) and deep-merge each group into one composite "current
    // state" record — see groupAndMergeByPiid / mergeAwardRecord above.
    const groups = groupAndMergeByPiid(allRecords)

    const results = groups.map(({ composite, matchedBy, modificationCount, latestModificationNumber }) => ({
      raw: composite,
      matchedBy,
      modificationCount,
      latestModificationNumber,
      fields: extractMappedFields(composite),
    }))

    const response = { results, count: results.length }
    await setCached(env, cacheKey, response)
    return json(response)
  } catch (err) {
    console.error('[Awards] Lookup error:', err.message)
    return json({ error: err.message }, 502)
  }
}

export async function handleAwards(req, env) {
  const url = new URL(req.url)
  if (url.pathname === '/awards/lookup' && req.method === 'GET') {
    return handleLookup(req, env)
  }
  return json({ error: 'Not found' }, 404)
}
