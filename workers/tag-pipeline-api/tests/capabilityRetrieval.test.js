import assert from 'node:assert/strict'
import test from 'node:test'
import {
  capabilityChunks,
  matchingPeopleSearchAliases,
  normalizePeopleSearchQueries,
  normalizePeopleSearchSuggestion,
  retrieveCapabilityExcerpts,
} from '../src/handlers/ai.js'

const documentText = [
  ...Array.from({ length: 14 }, (_, index) => `TAG delivers cloud modernization, program management, and mission support services for federal customers. Reference section ${index + 1}.`),
  'Health IT capabilities include data interoperability, clinical workflow modernization, and secure analytics for federal health agencies.',
  'Cybersecurity capabilities include zero trust architecture, authorization support, vulnerability management, and continuous monitoring.',
  'Logistics capabilities include supply chain analysis, asset management, and operational readiness planning.',
].join('\n\n')

test('keeps the full document available as multiple retrievable sections', () => {
  const chunks = capabilityChunks(documentText)
  assert.ok(chunks.length >= 2)
  assert.ok(chunks.join('\n').includes('Logistics capabilities'))
})

test('returns the section relevant to a capability question outside the document opening', () => {
  const excerpts = retrieveCapabilityExcerpts(documentText, 'What cybersecurity and zero trust capabilities do we have?')
  assert.ok(excerpts.length > 0)
  assert.ok(excerpts.join('\n').includes('zero trust architecture'))
})

test('normalizes and deduplicates public LinkedIn profile queries', () => {
  const queries = normalizePeopleSearchQueries({
    queries: [
      {
        label: 'Program office',
        purpose: 'Find personnel close to the supported office',
        query: '"DoDEA Pacific" (manager OR director)',
      },
      {
        label: 'Duplicate',
        purpose: '',
        query: 'site:www.linkedin.com/in/ "DoDEA Pacific" (manager OR director)',
      },
    ],
  })

  assert.equal(queries.length, 1)
  assert.equal(queries[0].query, 'site:linkedin.com/in/ "DoDEA Pacific" (manager OR director)')
})

test('normalizes one notes-based query and its controlled broader fallback', () => {
  const suggestion = normalizePeopleSearchSuggestion({
    query: '"DoDEA" ("Pacific Region" OR "Pacific Area Office") ("program manager" OR coordinator) esports',
    broadenedQuery: '"DoDEA" ("Pacific Region" OR "Pacific Area Office") ("program manager" OR coordinator)',
    summary: 'Find program personnel supporting Pacific esports work.',
    concepts: {
      organization: ['DoDEA'],
      officeOrProgram: ['Pacific Region'],
      roles: ['Program manager', 'Coordinator'],
      keywords: ['Esports'],
    },
    aliasesUsed: ['DoDEA', 'DoWEA'],
  }, [{
    members: ['Department of Defense Education Activity', 'DoDEA', 'DoWEA'],
  }])

  assert.equal(suggestion.queries.length, 1)
  assert.match(suggestion.query, /^site:linkedin\.com\/in\//)
  assert.match(suggestion.broadenedQuery, /^site:linkedin\.com\/in\//)
  assert.deepEqual(suggestion.aliasesUsed, ['DoDEA', 'DoWEA'])
})

test('offers approved DoDEA and DoWEA aliases only when notes establish that agency', () => {
  assert.equal(matchingPeopleSearchAliases([{ text: 'Research points to the DoDEA Pacific office.' }]).length, 1)
  assert.equal(matchingPeopleSearchAliases([{ text: 'Research points to a Pacific regional office.' }]).length, 0)
})
