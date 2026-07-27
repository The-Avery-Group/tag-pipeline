import { workerJson } from '@/services/workerClient'

export const LINKEDIN_PROFILE_SITE_FILTER = 'site:linkedin.com/in/'

function cleanTerm(value) {
  return String(value || '')
    .replace(/["“”]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function cleanQuery(value) {
  return String(value || '')
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
}

function quoted(value) {
  const cleaned = cleanTerm(value)
  return cleaned ? `"${cleaned}"` : ''
}

function terms(value, limit = 6) {
  return String(value || '')
    .split(/[,;\n]+/)
    .map(cleanTerm)
    .filter(Boolean)
    .slice(0, limit)
}

function orGroup(values, { quoteTerms = true } = {}) {
  const unique = [...new Set(values.map(cleanTerm).filter(Boolean))]
  if (!unique.length) return ''
  const format = (value) => quoteTerms ? quoted(value) : value
  if (unique.length === 1) return format(unique[0])
  return `(${unique.map(format).join(' OR ')})`
}

function organizationGroup(values) {
  const unique = [...new Set(values.map(cleanTerm).filter(Boolean))]
  const format = (value) => /\s/.test(value) ? quoted(value) : value
  if (!unique.length) return ''
  if (unique.length === 1) return format(unique[0])
  return `(${unique.map(format).join(' OR ')})`
}

function compactQuery(parts) {
  return [LINKEDIN_PROFILE_SITE_FILTER, ...parts.filter(Boolean)].join(' ').trim()
}

function uniqueQueries(items) {
  const seen = new Set()
  return items.filter((item) => {
    const query = String(item?.query || '').trim()
    const key = query.toLowerCase()
    if (!query || seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function cleanList(value, limit = 12) {
  const seen = new Set()
  return (Array.isArray(value) ? value : []).flatMap((item) => {
    const cleaned = cleanTerm(item)
    const key = cleaned.toLowerCase()
    if (!cleaned || seen.has(key)) return []
    seen.add(key)
    return [cleaned]
  }).slice(0, limit)
}

/**
 * Immediate, no-AI fallback that keeps People Search usable if Groq is busy.
 * AI suggestions refine these queries; they are never required to search.
 */
export function buildDefaultPeopleQueries({
  organization = '',
  program = '',
  keywords = '',
  context = {},
} = {}) {
  const opportunity = context.opportunity || {}
  const keywordTerms = terms(keywords)
  const organizationTerms = terms(organization, 3)
  const agencyTerms = [
    opportunity.agency,
    opportunity.department,
  ].map(cleanTerm).filter(Boolean)
  const officeTerms = [
    program,
    opportunity.office,
    opportunity.title,
  ].map(cleanTerm).filter(Boolean)

  const primaryOrganization = organizationGroup(organizationTerms)
  const primaryProgram = orGroup(officeTerms.slice(0, 2), { quoteTerms: false })
  const capabilities = orGroup(keywordTerms, { quoteTerms: false })
  const roleTerms = orGroup([
    'program manager',
    'program director',
    'account director',
    'operations manager',
  ])

  return uniqueQueries([
    {
      label: 'Organization and program',
      purpose: 'Find people whose public profile connects the organization to the program or office.',
      query: compactQuery([primaryOrganization, primaryProgram, capabilities]),
    },
    {
      label: 'Organization and likely roles',
      purpose: 'Find likely program, account, and operational personnel at the organization.',
      query: compactQuery([primaryOrganization, capabilities, roleTerms]),
    },
    {
      label: 'Agency and supported office',
      purpose: 'Find public personnel close to the government customer, office, or supported program.',
      query: compactQuery([
        organizationGroup(agencyTerms),
        primaryProgram,
        orGroup(['manager', 'director', 'coordinator', 'specialist'], { quoteTerms: false }),
      ]),
    },
  ]).filter((item) => item.query !== LINKEDIN_PROFILE_SITE_FILTER)
}

export function ensureLinkedInSiteFilter(query) {
  const value = String(query || '').trim()
  if (!value) return LINKEDIN_PROFILE_SITE_FILTER
  if (/site:\s*(?:www\.)?linkedin\.com\/in\/?/i.test(value)) {
    return value.replace(/site:\s*(?:www\.)?linkedin\.com\/in\/?/i, LINKEDIN_PROFILE_SITE_FILTER)
  }
  return `${LINKEDIN_PROFILE_SITE_FILTER} ${value}`
}

export function googleSearchUrl(query) {
  return `https://www.google.com/search?q=${encodeURIComponent(ensureLinkedInSiteFilter(query))}`
}

export async function suggestPeopleSearchQueries(input, { signal } = {}) {
  const payload = await workerJson('/ai/people-search-queries', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
    signal,
  })
  const primaryQuery = cleanQuery(payload.query || payload.queries?.[0]?.query)
  const queries = primaryQuery
    ? [{
        label: 'Research notes',
        purpose: cleanTerm(payload.summary || payload.queries?.[0]?.purpose),
        query: ensureLinkedInSiteFilter(primaryQuery),
      }]
    : []
  return {
    ...payload,
    query: queries[0]?.query || '',
    broadenedQuery: payload.broadenedQuery
      ? ensureLinkedInSiteFilter(cleanQuery(payload.broadenedQuery))
      : '',
    summary: cleanTerm(payload.summary),
    concepts: {
      organization: cleanList(payload.concepts?.organization),
      officeOrProgram: cleanList(payload.concepts?.officeOrProgram),
      roles: cleanList(payload.concepts?.roles),
      keywords: cleanList(payload.concepts?.keywords),
    },
    aliasesUsed: cleanList(payload.aliasesUsed),
    insufficientReason: cleanTerm(payload.insufficientReason),
    queries,
  }
}

export function contactDraftFromSearchResult(result, organization = '', scopeLabel = '') {
  const cleanTitle = String(result?.title || '')
    .replace(/\s*[|·]\s*LinkedIn.*$/i, '')
    .replace(/\s+-\s+LinkedIn.*$/i, '')
    .trim()
  const titleParts = cleanTitle.split(/\s+-\s+/).map((part) => part.trim()).filter(Boolean)
  const name = titleParts.shift() || ''
  const title = titleParts.join(' - ')
  const sourceLine = result?.url ? `Public LinkedIn profile: ${result.url}` : ''
  const scopeLine = scopeLabel ? `Found through People Search for ${scopeLabel}.` : 'Found through People Search.'

  return {
    Name: name,
    Title: title,
    Agency: cleanTerm(organization),
    Organization: '',
    Offices: '',
    Email: '',
    Phone: '',
    Notes: [sourceLine, scopeLine].filter(Boolean).join('\n'),
    Type: 'Private',
  }
}
