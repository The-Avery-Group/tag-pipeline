/**
 * SAM.gov Contract Award Record Lookup.
 *
 * A contract award is a family of base and modification transactions. SAM
 * does not guarantee that a later transaction repeats every unchanged field,
 * so this handler creates an explicit, source-aware snapshot for each field.
 * It deliberately does not recursively merge arbitrary API objects.
 */

const AWARDS_BASE = 'https://api.sam.gov/contract-awards/v1/search'
const OPPORTUNITIES_BASE = 'https://api.sam.gov/opportunities/v2/search'
const CACHE_TTL_SECONDS = 24 * 60 * 60
const PAGE_SIZE = 100
const MAX_PAGES = 4
const MAX_AWARD_NOTICE_LOOKUPS = 5

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function isPresent(value) {
  return value !== null && value !== undefined && value !== ''
}

function recordDate(record) {
  // A base award (modification number 0) can be re-indexed or edited in SAM
  // long after it was signed. Its SAM metadata timestamp must not make it
  // appear newer than subsequent modifications.
  const value = record?.awardDetails?.dates?.dateSigned ||
    record?.awardDetails?.transactionData?.approvedDate ||
    record?.awardDetails?.transactionData?.lastModifiedDate
  const date = value ? new Date(value) : null
  return date && !Number.isNaN(date.getTime()) ? date : new Date(0)
}

function normalizeIdentifier(value) {
  return String(value || '').trim().toUpperCase()
}

function normalizedIdentifier(value) {
  return normalizeIdentifier(value).replace(/-/g, '')
}

function stableRecordId(record) {
  const contract = record?.contractId || {}
  return [
    contract.subtier?.code || '',
    contract.piid || '',
    contract.referencedIDVSubtier?.code || '',
    contract.referencedIDVPiid || '',
    contract.modificationNumber || '',
    contract.transactionNumber || '',
    record?.awardDetails?.dates?.dateSigned || '',
    record?.awardDetails?.transactionData?.lastModifiedDate || '',
  ].join('|')
}

function dedupeRecords(records) {
  const seen = new Map()
  for (const record of records) {
    const key = stableRecordId(record)
    const existing = seen.get(key)
    if (existing) {
      existing._matchedBy = [...new Set([...(existing._matchedBy || []), ...(record._matchedBy || [])])]
    } else {
      seen.set(key, { ...record, _matchedBy: [...(record._matchedBy || [])] })
    }
  }
  return [...seen.values()]
}

function buildSamGovLink(record) {
  const piid = record?.contractId?.piid
  if (!piid) return null
  const params = new URLSearchParams({
    agencyID: record?.contractId?.subtier?.code || 'null',
    modNumber: record?.contractId?.modificationNumber || '',
    transactionNumber: record?.contractId?.transactionNumber ?? '0',
    refIdvPiid: record?.contractId?.referencedIDVPiid || 'null',
    idvAgencyID: record?.contractId?.referencedIDVSubtier?.code || 'null',
    contractType: record?.coreData?.awardOrIDV || 'AWARD',
  })
  return `https://sam.gov/workspace/contract/award/view/${encodeURIComponent(piid)}?${params}`
}

function sourceFor(record) {
  return {
    modificationNumber: record?.contractId?.modificationNumber || null,
    transactionNumber: record?.contractId?.transactionNumber || null,
    dateSigned: record?.awardDetails?.dates?.dateSigned || null,
    lastModifiedDate: record?.awardDetails?.transactionData?.lastModifiedDate || null,
  }
}

function latestValue(records, getValue) {
  for (let i = records.length - 1; i >= 0; i--) {
    const value = getValue(records[i])
    if (isPresent(value)) return { value, source: sourceFor(records[i]) }
  }
  return { value: null, source: null }
}

function field(section, label, resolved, column = null, options = {}) {
  return {
    section,
    label,
    value: resolved?.value ?? null,
    column,
    provenance: resolved?.source || null,
    ...options,
  }
}

function extractCurrentStateFields(records, aggregation, awardNotice) {
  const latest = (getter) => latestValue(records, getter)
  const totalContractValue = latest((record) =>
    record?.awardDetails?.totalContractDollars?.totalBaseAndAllOptionsValue ||
    record?.awardDetails?.dollars?.baseAndAllOptionsValue
  )
  const noticePoc = awardNotice?.primaryPoc

  return {
    piid: field('Contract identity', 'PIID (Contract Number)', latest((r) => r?.contractId?.piid)),
    incumbentName: field('Contract snapshot', 'Awardee (Incumbent)', latest((r) => r?.awardDetails?.awardeeData?.awardeeHeader?.awardeeName), 'Incumbent (Company Name)'),
    incumbentUEI: field('Contract snapshot', 'Awardee UEI', latest((r) => r?.awardDetails?.awardeeData?.awardeeUEIInformation?.uniqueEntityId), 'Incumbent (Company UEI)'),
    totalContractValue: field('Contract snapshot', 'Total Contract Value (Base + All Options)', totalContractValue, 'Total Contract Value ($)*', { format: 'currency' }),
    actualAggregateObligations: field('Contract snapshot', 'Actual Aggregate Obligations', { value: aggregation?.awardFamilySummary?.totalDollars ?? null, source: null }, null, { format: 'currency', helpText: 'Dollars the government has obligated across the award family to date.' }),
    awardType: field('Contract identity', 'Award Type', latest((r) => r?.coreData?.awardOrIDVType?.name), 'Contract Classification*'),
    contractVehicleNumber: field('Contract identity', 'Referenced IDV PIID', latest((r) => r?.contractId?.referencedIDVPiid), 'Contract Vehicle Number'),
    solicitationNumber: field('Contract identity', 'Solicitation Number', latest((r) => r?.coreData?.solicitationId), 'Solicitation Number'),
    department: field('Agency and scope', 'Department', latest((r) => r?.coreData?.federalOrganization?.contractingInformation?.contractingDepartment?.name), 'Department*'),
    agency: field('Agency and scope', 'Contracting Subtier', latest((r) => r?.coreData?.federalOrganization?.contractingInformation?.contractingSubtier?.name), 'Agency*'),
    office: field('Agency and scope', 'Contracting Office', latest((r) => r?.coreData?.federalOrganization?.contractingInformation?.contractingOffice?.name), 'Office*'),
    fiscalYear: field('Agency and scope', 'Fiscal Year', latest((r) => r?.awardDetails?.dates?.fiscalYear), 'Fiscal Year'),
    periodOfPerformanceStart: field('Contract snapshot', 'Period of Performance Start', latest((r) => r?.awardDetails?.dates?.periodOfPerformanceStartDate), null, { format: 'date' }),
    contractEndDate: field('Contract snapshot', 'Estimated Completion Date', latest((r) => r?.awardDetails?.dates?.ultimateCompletionDate), 'Contract End Date*', { format: 'date' }),
    description: field('Agency and scope', 'Description', latest((r) => r?.awardDetails?.productOrServiceInformation?.descriptionOfContractRequirement), null, { fullWidth: true }),
    typeOfContract: field('Agency and scope', 'Type of Contract', latest((r) => r?.coreData?.acquisitionData?.typeOfContractPricing?.name)),
    numberOfActions: field('Agency and scope', 'Number of Actions', latest((r) => r?.awardDetails?.contractData?.numberOfActions)),
    productServiceCode: field('Agency and scope', 'Product/Service Code', latest((r) => r?.coreData?.productOrServiceInformation?.productOrService?.code)),
    naicsCode: field('Agency and scope', 'Principal NAICS Code', latest((r) => r?.coreData?.productOrServiceInformation?.principalNaics?.[0]?.code), 'NAICS Code*'),
    setAside: field('Agency and scope', 'Type of Set-Aside', latest((r) => r?.coreData?.competitionInformation?.typeOfSetAside?.name), 'Set- Aside*'),
    solicitationProcedures: field('Agency and scope', 'Solicitation Procedures', latest((r) => r?.coreData?.competitionInformation?.solicitationProcedures?.name)),
    numberOfOffersReceived: field('Agency and scope', 'Number of Offers Received', latest((r) => r?.awardDetails?.competitionInformation?.numberOfOffersReceived)),
    awardNoticeStatus: field('Award notice', 'Corroboration', { value: awardNotice?.status || null, source: null }, null, { fullWidth: true }),
    awardNoticeNumber: field('Award notice', 'Award Notice Number', { value: awardNotice?.awardNumber || null, source: null }),
    awardNoticeDate: field('Award notice', 'Award Notice Date', { value: awardNotice?.awardDate || null, source: null }, null, { format: 'date' }),
    awardNoticeAmount: field('Award notice', 'Award Notice Amount', { value: awardNotice?.awardAmount || null, source: null }, null, { format: 'currency' }),
    awardNoticeAwardee: field('Award notice', 'Award Notice Awardee', { value: awardNotice?.awardeeName || null, source: null }),
    awardNoticePoc: field('Award notice', 'Primary Point of Contact', { value: noticePoc ? [noticePoc.fullName, noticePoc.title, noticePoc.email, noticePoc.phone].filter(Boolean).join(' · ') : null, source: null }, null, { fullWidth: true }),
    awardNoticeLink: field('Award notice', 'Award Notice Link', { value: awardNotice?.link || null, source: null }, null, { format: 'link', action: 'addOtherLink' }),
  }
}

function extractTransactionFields(record) {
  const transaction = record?.awardDetails?.transactionData
  return {
    modificationNumber: field('Latest modification', 'Modification Number', { value: record?.contractId?.modificationNumber ?? null, source: sourceFor(record) }),
    dateSigned: field('Latest modification', 'Date Signed', { value: record?.awardDetails?.dates?.dateSigned ?? null, source: sourceFor(record) }, null, { format: 'date' }),
    reasonForModification: field('Latest modification', 'Reason for Modification', { value: record?.contractId?.reasonForModification?.name ?? null, source: sourceFor(record) }, null, { fullWidth: true }),
    approvedDate: field('Latest modification', 'Approved Date', { value: transaction?.approvedDate ?? null, source: sourceFor(record) }, null, { format: 'date' }),
    samLastModifiedBy: field('Latest modification', 'SAM Record Last Modified By', { value: transaction?.lastModifiedBy ?? null, source: sourceFor(record) }),
    samLastModifiedDate: field('Latest modification', 'SAM Record Last Modified Date', { value: transaction?.lastModifiedDate ?? null, source: sourceFor(record) }, null, { format: 'date' }),
  }
}

// A later option exercise means the contract is treated as active again for
// the purposes of this UI alert. Other later modifications do not clear a
// termination, cancellation, or close-out event.
const LIFECYCLE_REASON_TYPES = {
  E: 'terminated',
  F: 'terminated',
  X: 'terminated',
  N: 'cancelled',
  K: 'closedOut',
}

const LIFECYCLE_REASON_FALLBACKS = {
  E: 'Terminate for Default',
  F: 'Terminate for Convenience',
  X: 'Terminate for Cause',
  N: 'Legal Contract Cancellation',
  K: 'Close Out',
}

function getLifecycleReason(record) {
  const reason = record?.contractId?.reasonForModification
  const code = String(reason?.code || '').trim().toUpperCase()
  const type = LIFECYCLE_REASON_TYPES[code]
  if (!type) return null
  return {
    type,
    reason: reason?.name || LIFECYCLE_REASON_FALLBACKS[code],
  }
}

function extractTransactionFields(record) {
  const transaction = record?.awardDetails?.transactionData
  const lifecycleReason = getLifecycleReason(record)
  return {
    modificationNumber: field('Latest modification', 'Modification Number', { value: record?.contractId?.modificationNumber ?? null, source: sourceFor(record) }),
    dateSigned: field('Latest modification', 'Date Signed', { value: record?.awardDetails?.dates?.dateSigned ?? null, source: sourceFor(record) }, null, { format: 'date' }),
    reasonForModification: field(
      'Latest modification',
      'Reason for Modification',
      { value: lifecycleReason?.reason || record?.contractId?.reasonForModification?.name || null, source: sourceFor(record) },
      null,
      { fullWidth: true, lifecycleAlert: Boolean(lifecycleReason) },
    ),
    approvedDate: field('Latest modification', 'Approved Date', { value: transaction?.approvedDate ?? null, source: sourceFor(record) }, null, { format: 'date' }),
    samLastModifiedBy: field('Latest modification', 'SAM Record Last Modified By', { value: transaction?.lastModifiedBy ?? null, source: sourceFor(record) }),
    samLastModifiedDate: field('Latest modification', 'SAM Record Last Modified Date', { value: transaction?.lastModifiedDate ?? null, source: sourceFor(record) }, null, { format: 'date' }),
  }
}

function getContractLifecycleAlert(records) {
  let alert = null

  for (const record of records) {
    const reason = record?.contractId?.reasonForModification
    const code = String(reason?.code || '').trim().toUpperCase()
    const code = String(record?.contractId?.reasonForModification?.code || '').trim().toUpperCase()
    if (code === 'G') {
      alert = null
      continue
    }
    if (!LIFECYCLE_REASON_TYPES[code]) continue
    const lifecycleReason = getLifecycleReason(record)
    if (!lifecycleReason) continue

    alert = {
      type: LIFECYCLE_REASON_TYPES[code],
      reason: reason?.name || LIFECYCLE_REASON_FALLBACKS[code],
      ...lifecycleReason,
      modificationNumber: record?.contractId?.modificationNumber || null,
      transactionNumber: record?.contractId?.transactionNumber || null,
      dateSigned: record?.awardDetails?.dates?.dateSigned || null,
    }
  }

  return alert
}

async function fetchAwards(env, params) {
  const records = []
  let aggregation = null
  let offset = 0

  for (let page = 0; page < MAX_PAGES; page++) {
    const query = new URLSearchParams({ api_key: env.SAM_API_KEY, ...params, limit: String(PAGE_SIZE), offset: String(offset) })
    const response = await fetch(`${AWARDS_BASE}?${query}`)
    if (response.status === 204) break
    if (!response.ok) {
      const body = await response.text()
      throw new Error(`Awards API error ${response.status}: ${body.slice(0, 300)}`)
    }
    const data = await response.json()
    records.push(...(data.awardSummary || []))
    aggregation ||= data.piidAggregation || null
    const total = data.totalRecords ?? records.length
    offset += PAGE_SIZE
    if (offset >= total || (data.awardSummary || []).length < PAGE_SIZE) break
  }
  return { records, aggregation }
}

async function fetchPiidAggregation(env, piid) {
  if (!piid) return null
  try {
    // Aggregation is response metadata, so one small page is sufficient.
    // Do not page the full family again for this value.
    const query = new URLSearchParams({
      api_key: env.SAM_API_KEY,
      piid,
      piidAggregation: 'yes',
      limit: '1',
      offset: '0',
    })
    const response = await fetch(`${AWARDS_BASE}?${query}`)
    if (response.status === 204) return null
    if (!response.ok) {
      const body = await response.text()
      throw new Error(`Awards API error ${response.status}: ${body.slice(0, 160)}`)
    }
    const data = await response.json()
    return data.piidAggregation || null
  } catch (error) {
    // SAM rejects aggregation for non-unique PIIDs unless additional identity
    // parameters are supplied. The lookup itself remains valid in that case.
    console.info('[Awards] PIID aggregation unavailable:', error.message)
    return null
  }
}

function formatSamDate(date) {
  return `${String(date.getUTCMonth() + 1).padStart(2, '0')}/${String(date.getUTCDate()).padStart(2, '0')}/${date.getUTCFullYear()}`
}

function dateWindow(dateValue) {
  const center = new Date(dateValue)
  if (Number.isNaN(center.getTime())) return null
  const from = new Date(Date.UTC(center.getUTCFullYear(), center.getUTCMonth(), center.getUTCDate()))
  const to = new Date(from)
  from.setUTCDate(from.getUTCDate() - 182)
  to.setUTCDate(to.getUTCDate() + 181)
  return { from: formatSamDate(from), to: formatSamDate(to) }
}

function primaryPoc(pointOfContact) {
  if (!Array.isArray(pointOfContact) || pointOfContact.length === 0) return null
  return pointOfContact.find((poc) => String(poc?.type || '').toLowerCase() === 'primary') || pointOfContact[0]
}

function noticeLink(notice) {
  const value = String(notice?.uiLink || '').trim()
  return value && value !== 'null' ? value : null
}

async function searchAwardNotices(env, solicitationNumber, window) {
  const query = new URLSearchParams({
    api_key: env.SAM_API_KEY,
    ptype: 'a',
    solnum: solicitationNumber,
    postedFrom: window.from,
    postedTo: window.to,
    limit: '10',
    offset: '0',
  })
  const response = await fetch(`${OPPORTUNITIES_BASE}?${query}`)
  if (response.status === 204) return []
  if (!response.ok) {
    const body = await response.text()
    console.info('[Awards] Award Notice lookup unavailable:', response.status, body.slice(0, 120))
    return null
  }
  const data = await response.json()
  return data.opportunitiesData || data.data || []
}

async function findAwardNotice(env, { piid, solicitationNumber, originalSignedDate, awardeeName }) {
  const window = dateWindow(originalSignedDate)
  if (!solicitationNumber || !window) {
    return { status: 'No Award Notice search available because this award has no solicitation number or signed date.' }
  }

  // Award Notices are found exclusively by solicitation number. Try the
  // source value first, then retry without dashes when the exact form has no
  // result. PIID is used only to corroborate a returned notice, never to
  // drive this Opportunities API search.
  const sourceSolicitationNumber = String(solicitationNumber).trim()
  const dashlessSolicitationNumber = sourceSolicitationNumber.replace(/-/g, '')
  let notices = await searchAwardNotices(env, sourceSolicitationNumber, window)
  if (notices === null) return { status: 'Award Notice lookup unavailable.' }

  let usedDashlessSolicitation = false
  if (notices.length === 0 && dashlessSolicitationNumber && dashlessSolicitationNumber !== sourceSolicitationNumber) {
    notices = await searchAwardNotices(env, dashlessSolicitationNumber, window)
    usedDashlessSolicitation = true
    if (notices === null) return { status: 'Award Notice lookup unavailable.' }
  }
  if (!notices.length) return { status: 'No matching Award Notice found.' }

  const normalizedPiid = normalizedIdentifier(piid)
  const normalizedAwardee = String(awardeeName || '').trim().toLowerCase()
  const ranked = [...notices].sort((a, b) => {
    const score = (notice) => {
      const awardNumber = normalizedIdentifier(notice?.award?.number)
      if (awardNumber && normalizedIdentifier(piid) === awardNumber) return 4
      if (awardNumber && normalizedIdentifier(notice?.award?.number) === normalizedPiid) return 4
      if (normalizedAwardee && String(notice?.award?.awardee?.name || '').trim().toLowerCase() === normalizedAwardee) return 2
      return 1
    }
    return score(b) - score(a)
  })
  const notice = ranked[0]
  const exactAwardNumber = normalizedIdentifier(notice?.award?.number) === normalizedIdentifier(piid) ||
    normalizedIdentifier(notice?.award?.number) === normalizedPiid
  return {
    status: exactAwardNumber
      ? `Located by solicitation number${usedDashlessSolicitation ? ' (without dashes)' : ''}; the Award Notice number agrees with the PIID.`
      : `Located by solicitation number${usedDashlessSolicitation ? ' (without dashes)' : ''}. Verify the Award Notice number before relying on this notice.`,
    noticeId: notice?.noticeId || null,
    title: notice?.title || null,
    awardNumber: notice?.award?.number || null,
    awardDate: notice?.award?.date || null,
    awardAmount: notice?.award?.amount || null,
    awardeeName: notice?.award?.awardee?.name || null,
    primaryPoc: primaryPoc(notice?.pointOfContact),
    pointOfContact: Array.isArray(notice?.pointOfContact) ? notice.pointOfContact : [],
    link: noticeLink(notice),
  }
}

function groupByAwardFamily(records) {
  const groups = new Map()
  for (const record of records) {
    const contract = record?.contractId || {}
    const key = [contract.subtier?.code || '', contract.piid || '', contract.referencedIDVSubtier?.code || '', contract.referencedIDVPiid || ''].join('|')
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(record)
  }
  return [...groups.values()].map((group) => [...group].sort((a, b) => recordDate(a) - recordDate(b)))
}

async function buildResult(env, records, includeAwardNotice = true) {
  const latest = records[records.length - 1]
  const piid = latestValue(records, (record) => record?.contractId?.piid).value
  const solicitationNumber = latestValue(records, (record) => record?.coreData?.solicitationId).value
  const originalSignedDate = records[0]?.awardDetails?.dates?.dateSigned || null
  const incumbentName = latestValue(records, (record) => record?.awardDetails?.awardeeData?.awardeeHeader?.awardeeName).value
  const aggregation = await fetchPiidAggregation(env, piid)
  const awardNotice = includeAwardNotice
    ? await findAwardNotice(env, { piid, solicitationNumber, originalSignedDate, awardeeName: incumbentName })
    : { status: 'Award Notice lookup skipped because this search returned more than five award families. Refine the search to check this record.' }
  const fields = {
    ...extractCurrentStateFields(records, aggregation, awardNotice),
    ...extractTransactionFields(latest),
  }

  return {
    raw: latest,
    piid,
    isIDV: latestValue(records, (record) => record?.coreData?.awardOrIDV).value === 'IDV',
    matchedBy: [...new Set(records.flatMap((record) => record._matchedBy || []))],
    modificationCount: records.length,
    latestModificationNumber: latest?.contractId?.modificationNumber || null,
    originalSignedDate,
    samLink: buildSamGovLink(latest),
    fields,
    awardNotice,
    aggregation,
    contractLifecycleAlert: getContractLifecycleAlert(records),
    // Preserve raw transaction history for later automatic change monitoring
    // and for a future UI history view without fabricating composite records.
    modifications: records.slice(-3).reverse().map((record) => extractTransactionFields(record)),
  }
}

async function getCached(env, key) {
  return env.CACHE ? env.CACHE.get(key, 'json') : null
}

async function setCached(env, key, value) {
  if (env.CACHE) await env.CACHE.put(key, JSON.stringify(value), { expirationTtl: CACHE_TTL_SECONDS })
}

async function handleLookup(req, env) {
  if (!env.SAM_API_KEY) return json({ error: 'SAM_API_KEY not configured' }, 503)

  const url = new URL(req.url)
  const piid = url.searchParams.get('piid')?.trim()
  const solicitationID = url.searchParams.get('solicitationID')?.trim()
  const forceRefresh = url.searchParams.get('refresh') === '1'
  if (!piid && !solicitationID) return json({ error: 'Provide at least one of: piid, solicitationID' }, 400)

  const cacheKey = `awards_lookup:v4:${piid || ''}:${solicitationID || ''}`
  const cacheKey = `awards_lookup:v5:${piid || ''}:${solicitationID || ''}`
  if (!forceRefresh) {
    const cached = await getCached(env, cacheKey)
    if (cached) {
      return json({
        ...cached,
        cached: true,
        cache: { source: 'cache', fetchedAt: cached.cachedAt, expiresAt: cached.cacheExpiresAt },
      })
    }
  }

  try {
    const calls = []
    if (piid) calls.push(fetchAwards(env, { piid }).then(({ records }) => records.map((record) => ({ ...record, _matchedBy: ['PIID'] }))))
    if (solicitationID) calls.push(fetchAwards(env, { solicitationID }).then(({ records }) => records.map((record) => ({ ...record, _matchedBy: ['Solicitation Number'] }))))
    let records = dedupeRecords((await Promise.all(calls)).flat())

    // Preserve the identifier exactly in the pipeline. This is a search-only
    // fallback for users who omit dashes when typing a PIID.
    const compactPiid = piid ? normalizedIdentifier(piid) : ''
    if (piid && records.length === 0 && compactPiid && compactPiid !== normalizeIdentifier(piid)) {
      const fallback = await fetchAwards(env, { piid: compactPiid })
      records = dedupeRecords(fallback.records.map((record) => ({ ...record, _matchedBy: ['Normalized PIID'] })))
    }

    const families = groupByAwardFamily(records)
    const results = await Promise.all(families.map((family, index) => buildResult(env, family, index < MAX_AWARD_NOTICE_LOOKUPS)))
    const cachedAt = new Date().toISOString()
    const response = {
      results,
      count: results.length,
      cachedAt,
      cacheExpiresAt: new Date(Date.now() + CACHE_TTL_SECONDS * 1000).toISOString(),
    }
    await setCached(env, cacheKey, response)
    return json({ ...response, cached: false, cache: { source: 'live', fetchedAt: cachedAt, expiresAt: response.cacheExpiresAt } })
  } catch (error) {
    console.error('[Awards] Lookup error:', error.message)
    return json({ error: error.message }, 502)
  }
}

export async function handleAwards(req, env) {
  const url = new URL(req.url)
  if (url.pathname === '/awards/lookup' && req.method === 'GET') return handleLookup(req, env)
  return json({ error: 'Not found' }, 404)
}
