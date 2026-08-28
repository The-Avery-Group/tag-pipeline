import assert from 'node:assert/strict'
import test from 'node:test'

import { extractCitedRequirements, extractDocumentSections } from '../src/lib/documentAnalysis.js'

test('plain-text documents retain section citations for extracted requirements', async () => {
  const bytes = new TextEncoder().encode('Background information.\n\nThe contractor shall provide weekly status reports. The response must include a staffing plan.')
  const sections = await extractDocumentSections(bytes, 'requirements.txt', 'text/plain')
  const requirements = extractCitedRequirements(sections, 'requirements.txt')
  assert.equal(requirements.length, 2)
  assert.deepEqual(requirements[0].citation, { fileName: 'requirements.txt', location: 'section 2' })
  assert.match(requirements[0].text, /shall provide weekly status reports/i)
})

test('ordinary narrative is not presented as a solicitation requirement', () => {
  const requirements = extractCitedRequirements([{ text: 'This document provides background about the program.', location: 'page 1' }], 'notice.pdf')
  assert.deepEqual(requirements, [])
})
