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
    summary: 'Find program personnel supporting Pacific esports work.',
    concepts: {
      organization: ['DoDEA'],
      officeOrProgram: ['Pacific Region', 'Pacific Area Office'],
      roles: ['Program Manager', 'Program Director', 'Coordinator'],
      keywords: ['Esports'],
    },
  }, [{
    members: ['Department of Defense Education Activity', 'DoDEA', 'DoWEA'],
  }])

  assert.equal(suggestion.queries.length, 1)
  assert.match(suggestion.query, /^site:linkedin\.com\/in\//)
  assert.match(suggestion.query, /\("Department of Defense Education Activity" OR DoDEA OR DoWEA\)/)
  assert.match(suggestion.query, /\(Pacific Region OR Pacific Area Office\)/)
  assert.match(suggestion.query, /\("Program Manager" OR "Program Director" OR Coordinator\)/)
  assert.match(suggestion.query, /Esports$/)
  assert.match(suggestion.broadenedQuery, /^site:linkedin\.com\/in\//)
  assert.doesNotMatch(suggestion.broadenedQuery, /Esports/)
  assert.deepEqual(suggestion.aliasesUsed, ['Department of Defense Education Activity', 'DoDEA', 'DoWEA'])
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
            summary: 'Find program personnel connected to the Pacific region.',
            concepts: {
              organization: ['DoDEA'],
              officeOrProgram: ['Pacific Region'],
              roles: ['Program manager', 'Coordinator'],
              keywords: [],
            },
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
    assert.match(requestBody.messages[0].content, /organization must identify the agency/i)
    assert.match(requestBody.messages[0].content, /function-specific, plausible title families/i)
    assert.match(requestBody.messages[0].content, /application formats the final Google query/i)
    const payload = await response.json()
    assert.match(payload.query, /^site:linkedin\.com\/in\//)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('falls back to the next model when Groq rejects structured query generation', async () => {
  const originalFetch = globalThis.fetch
  const requestedModels = []
  globalThis.fetch = async (_url, options) => {
    const requestBody = JSON.parse(options.body)
    requestedModels.push(requestBody.model)
    if (requestedModels.length === 1) {
      return new Response(JSON.stringify({
        error: {
          code: 'failed_generation',
          message: 'Failed to generate JSON. Please adjust your prompt.',
        },
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    return new Response(JSON.stringify({
      choices: [{
        finish_reason: 'stop',
        message: {
          content: JSON.stringify({
            summary: 'Find personnel supporting the Pacific esports program.',
            concepts: {
              organization: ['DoDEA'],
              officeOrProgram: ['Pacific Region'],
              roles: ['Program Manager', 'Program Coordinator'],
              keywords: ['Esports'],
            },
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
          notes: [{ text: 'DoDEA Pacific Region esports program research.' }],
        },
      }),
    }), { GROQ_API_KEY: 'test-key' })

    assert.equal(response.status, 200)
    assert.deepEqual(requestedModels.slice(0, 2), ['openai/gpt-oss-120b', 'qwen/qwen3.6-27b'])
    const payload = await response.json()
    assert.match(payload.query, /DoDEA/)
    assert.match(payload.query, /Pacific Region/)
    assert.match(payload.query, /"Program Manager"/)
  } finally {
    globalThis.fetch = originalFetch
  }
})
