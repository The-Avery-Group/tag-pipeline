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

// Constructs a deep link to view this record on sam.gov itself. Confirmed
// against a real sam.gov URL for piid/modNumber/transactionNumber/
// refIdvPiid/contractType — `agencyID`/`idvAgencyID` are a best-effort
// mapping to contractId.subtier.code (unconfirmed; worth checking the first
// time this is used against a link you know is correct).
function buildSamGovLink(record) {
  const piid = record?.contractId?.piid
  if (!piid) return null
  const params = new URLSearchParams({
    agencyID:          record?.contractId?.subtier?.code || 'null',
    modNumber:         record?.contractId?.modificationNumber || '',
    transactionNumber: record?.contractId?.transactionNumber ?? '0',
    refIdvPiid:        record?.contractId?.referencedIDVPiid || 'null',
    idvAgencyID:       record?.contractId?.referencedIDVSubtier?.code || 'null',
    contractType:      record?.coreData?.awardOrIDV || 'AWARD',
  })
  return `https://sam.gov/workspace/contract/award/view/${encodeURIComponent(piid)}?${params}`
}

// Groups raw records by PIID (scoped by contracting subtier, in case the
// same PIID string were ever reused across subtiers), sorts each group
// chronologically, and folds it into one composite "current state" record —
// plus, separately, progressive snapshots for the last up to 3 modifications
// (most recent first) so the Lookup page can offer a history toggle without
// losing the "complete picture at any point" property the full merge gives.
function groupAndMergeByPiid(records) {
  const groups = new Map()
  for (const r of records) {
    const key = `${r?.contractId?.subtier?.code || ''}:${r?.contractId?.piid || ''}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(r)
  }

  const merged = []
  for (const group of groups.values()) {
    const sorted = [...group].sort((a, b) => recordDate(a) - recordDate(b))   // oldest → newest

    // Full composite across the WHOLE history — used for OpportunityDetail
    // (which only ever wants "the current picture", no history toggle) and
    // as the Lookup page's default view.
    let composite = sorted[0]
    for (let i = 1; i < sorted.length; i++) composite = mergeAwardRecord(composite, sorted[i])

    // Progressive snapshots for the last up-to-3 modifications, most recent
    // first. Each one's current-state fields reflect everything merged up
    // through that point (so toggling to an older mod still shows a
    // complete contract picture, not just whatever that one transaction
    // touched) — but its modification/history fields are that transaction's
    // own, unmerged, since those are meaningful only per-transaction.
    const last3 = sorted.slice(-3).reverse()
    const modifications = last3.map((modRecord) => {
      const idx = sorted.indexOf(modRecord)
      let progressive = sorted[0]
      for (let i = 1; i <= idx; i++) progressive = mergeAwardRecord(progressive, sorted[i])
      return {
        ...extractTransactionFields(modRecord),
        currentState: extractCurrentStateFields(progressive),
      }
    })

    const latest = sorted[sorted.length - 1]
    merged.push({
      composite,
      matchedBy: latest._matchedBy,
      modificationCount: sorted.length,
      latestModificationNumber: latest?.contractId?.modificationNumber || null,
      // The base award's signed date — a fixed historical fact, distinct
      // from "date signed" under Modification Details (which is per-mod).
      originalSignedDate: sorted[0]?.awardDetails?.dates?.dateSigned || null,
      samLink: buildSamGovLink(composite),
      // Latest transaction's own metadata, for the OpportunityDetail view
      // (which shows "current state" but still benefits from knowing what
      // the most recent change actually was, even without a toggle).
      latestTransactionFields: extractTransactionFields(latest),
      modifications,
    })
  }
  return merged
}

// ── Field extraction ────────────────────────────────────────────────────
// Each field carries its display section/label (so the frontend doesn't
// need its own duplicate label map) and the PipelineTable column it maps
// to, if any — many of these fields (award type, solicitation procedures,
// number of offers received, etc.) have no corresponding pipeline column
// and are display-only; `column: null` signals that to the frontend so it
// doesn't render an "update pipeline" button for something with nowhere to
// write to.
//
// Split into two functions because they behave differently across a
// contract's modification history:
//   - "current state" fields (extractCurrentStateFields) get progressively
//     merged — later mods' non-null values win, but nothing already set is
//     lost just because a later mod (e.g. a funding-only action) didn't
//     touch that field.
//   - "per-transaction" fields (extractTransactionFields) describe THAT
//     specific modification event (who signed it, why, when) and must
//     reflect exactly what that one record says — merging these across
//     mods would be meaningless (there's no single "current" reason for
//     modification, for example).

function extractCurrentStateFields(record) {
  const naics        = record?.coreData?.productOrServiceInformation?.principalNaics?.[0]
  const pos          = record?.coreData?.productOrServiceInformation?.productOrService
  const dept         = record?.coreData?.federalOrganization?.contractingInformation?.contractingDepartment
  const subtier      = record?.coreData?.federalOrganization?.contractingInformation?.contractingSubtier
  const office       = record?.coreData?.federalOrganization?.contractingInformation?.contractingOffice
  const setAside     = record?.coreData?.competitionInformation?.typeOfSetAside
  const solProc      = record?.coreData?.competitionInformation?.solicitationProcedures
  const awardeeHeader = record?.awardDetails?.awardeeData?.awardeeHeader
  const awardeeUEI    = record?.awardDetails?.awardeeData?.awardeeUEIInformation
  const awardOrIDVType = record?.coreData?.awardOrIDVType
  const typeOfContractPricing = record?.coreData?.acquisitionData?.typeOfContractPricing

  return {
    // SUMMARY
    piid:                   { section: 'Summary', label: 'PIID (Contract Number)', value: record?.contractId?.piid ?? null, column: 'Contract Number / Notice ID' },
    incumbentName:           { section: 'Summary', label: 'Awardee (Incumbent)', value: awardeeHeader?.awardeeName ?? null, column: 'Incumbent (Company Name)' },
    incumbentUEI:            { section: 'Summary', label: 'UEI', value: awardeeUEI?.uniqueEntityId ?? null, column: 'Incumbent (Company UEI)' },
    contractVehicleNumber:   { section: 'Summary', label: 'Referenced IDV PIID', value: record?.contractId?.referencedIDVPiid ?? null, column: 'Contract Vehicle Number' },
    totalEstimatedOrderValue:{ section: 'Summary', label: 'Total Estimated Order Value', value: record?.awardDetails?.dollars?.totalEstimatedOrderValue ?? null, column: 'Total Contract Value ($)*' },
    awardType:               { section: 'Summary', label: 'Award Type', value: awardOrIDVType?.name ?? null, column: null },
    department:              { section: 'Summary', label: 'Department', value: dept?.name ?? null, column: 'Department*' },
    agency:                  { section: 'Summary', label: 'Agency', value: subtier?.name ?? null, column: 'Agency*' },
    office:                  { section: 'Summary', label: 'Office', value: office?.name ?? null, column: 'Office*' },
    fiscalYear:              { section: 'Summary', label: 'Fiscal Year', value: record?.awardDetails?.dates?.fiscalYear ?? null, column: 'Fiscal Year' },

    // PERFORMANCE
    periodOfPerformanceStart:{ section: 'Performance', label: 'Period of Performance Start', value: record?.awardDetails?.dates?.periodOfPerformanceStartDate ?? null, column: null },
    contractEndDate:         { section: 'Performance', label: 'Estimated Completion Date', value: record?.awardDetails?.dates?.currentCompletionDate ?? null, column: 'Contract End Date*' },

    // SOLICITATION
    solicitationNumber:     { section: 'Solicitation', label: 'Solicitation Number', value: record?.coreData?.solicitationId ?? null, column: 'Solicitation Number' },
    solicitationDate:       { section: 'Solicitation', label: 'Solicitation Date', value: record?.coreData?.solicitationDate ?? null, column: null },

    // DESCRIPTION
    description:             { section: 'Description', label: 'Description', value: record?.awardDetails?.productOrServiceInformation?.descriptionOfContractRequirement ?? null, column: null },

    // CURRENT CONTRACT DETAILS
    typeOfContract:          { section: 'Contract Details', label: 'Type of Contract', value: typeOfContractPricing?.name ?? null, column: null },
    numberOfActions:         { section: 'Contract Details', label: 'Number of Actions', value: record?.awardDetails?.contractData?.numberOfActions ?? null, column: null },
    productServiceCode:      { section: 'Contract Details', label: 'Product/Service Code', value: pos?.code ?? null, column: null },
    naicsCode:               { section: 'Contract Details', label: 'Principal NAICS Code', value: naics?.code ?? null, column: 'NAICS Code*' },
    setAside:                { section: 'Contract Details', label: 'Type of Set-Aside', value: setAside?.name ?? null, column: 'Set- Aside*' },
    solicitationProcedures:  { section: 'Contract Details', label: 'Solicitation Procedures', value: solProc?.name ?? null, column: null },
    numberOfOffersReceived:  { section: 'Contract Details', label: 'Number of Offers Received', value: record?.awardDetails?.competitionInformation?.numberOfOffersReceived ?? null, column: null },
  }
}

function extractTransactionFields(record) {
  const td = record?.awardDetails?.transactionData
  return {
    // MODIFICATION DETAILS
    modificationNumber:     { section: 'Modification Details', label: 'Modification Number', value: record?.contractId?.modificationNumber ?? null, column: null },
    dateSigned:              { section: 'Modification Details', label: 'Date Signed', value: record?.awardDetails?.dates?.dateSigned ?? null, column: null },
    reasonForModification:  { section: 'Modification Details', label: 'Reason for Modification', value: record?.contractId?.reasonForModification?.name ?? null, column: null },

    // HISTORY — "prepared" isn't a literal field name in this API; mapped
    // to createdDate/createdBy as the closest semantic equivalent (the
    // person/date the record was first entered into the system).
    preparedDate:            { section: 'History', label: 'Prepared Date', value: td?.createdDate ?? null, column: null },
    approvedDate:            { section: 'History', label: 'Approved Date', value: td?.approvedDate ?? null, column: null },
    lastModifiedUser:        { section: 'History', label: 'Last Modified User', value: td?.lastModifiedBy ?? null, column: null },
    lastModifiedDate:        { section: 'History', label: 'Last Modified Date', value: td?.lastModifiedDate ?? null, column: null },
    approvedBy:              { section: 'History', label: 'Approved By', value: td?.approvedBy ?? null, column: null },
    preparedUser:            { section: 'History', label: 'Prepared User', value: td?.createdBy ?? null, column: null },
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

    const results = groups.map((g) => ({
      raw: g.composite,
      matchedBy: g.matchedBy,
      modificationCount: g.modificationCount,
      latestModificationNumber: g.latestModificationNumber,
      originalSignedDate: g.originalSignedDate,
      samLink: g.samLink,
      // OpportunityDetail's view: current-state fields (merged across the
      // whole history) plus the latest transaction's own metadata — no
      // history toggle, just "everything about where this stands now".
      fields: { ...extractCurrentStateFields(g.composite), ...g.latestTransactionFields },
      // Lookup page's view: up to the last 3 modifications, most recent
      // first, each a fully self-contained snapshot (current-state fields
      // as of that point + that transaction's own metadata).
      modifications: g.modifications,
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
