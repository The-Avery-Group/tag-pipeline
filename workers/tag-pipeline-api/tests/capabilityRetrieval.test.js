import assert from 'node:assert/strict'
import test from 'node:test'
import {
  capabilityChunks,
  handlePeopleSearchQueries,
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

test('requires schema-valid JSON from Groq for notes-based query generation', async () => {
  const originalFetch = globalThis.fetch
  let requestBody
  globalThis.fetch = async (_url, options) => {
    requestBody = JSON.parse(options.body)
    return new Response(JSON.stringify({
      choices: [{
        finish_reason: 'stop',
        message: {
          content: JSON.stringify({
            query: 'site:linkedin.com/in/ ("DoDEA" OR "DoWEA") ("Pacific Region") ("program manager" OR coordinator)',
            broadenedQuery: 'site:linkedin.com/in/ ("DoDEA" OR "DoWEA") ("program manager" OR coordinator)',
            summary: 'Find program personnel connected to the Pacific region.',
            concepts: {
              organization: ['DoDEA'],
              officeOrProgram: ['Pacific Region'],
              roles: ['Program manager', 'Coordinator'],
              keywords: [],
            },
            aliasesUsed: ['DoDEA', 'DoWEA'],
            insufficientReason: '',
          }),
        },
      }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  try {
    const response = await handlePeopleSearchQueries(new Request('https://worker.test/ai/people-search-queries', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sourceMode: 'opportunity-notes',
        context: {
          notes: [{ text: 'The research points to the DoDEA Pacific Region program office.' }],
        },
      }),
    }), { GROQ_API_KEY: 'test-key' })

    assert.equal(response.status, 200)
    assert.equal(requestBody.response_format.type, 'json_schema')
    assert.equal(requestBody.response_format.json_schema.strict, true)
    assert.match(requestBody.messages[0].content, /organization as a mandatory scope/i)
    assert.match(requestBody.messages[0].content, /never connect the organization group to roles or context with OR/i)
    assert.match(requestBody.messages[0].content, /do not quote acronyms, geographic regions/i)
    assert.match(requestBody.messages[0].content, /preserving the complete mandatory organization group/i)
    const payload = await response.json()
    assert.match(payload.query, /^site:linkedin\.com\/in\//)
  } finally {
    globalThis.fetch = originalFetch
  }
})
