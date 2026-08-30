import assert from 'node:assert/strict'
import test from 'node:test'

import { extractCitedRequirements, extractCriticalSubmissionDetails, extractDocumentSections } from '../src/lib/documentAnalysis.js'

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

test('critical scan separates questions and proposal delivery instructions with citations', () => {
  const critical = extractCriticalSubmissionDetails([
    { text: 'Questions must be emailed to jane.doe@example.gov no later than September 8, 2026 at 2:00 PM ET.', location: 'page 2' },
    { text: 'The proposal shall be submitted through PIEE by September 18, 2026 at 2:00 PM ET.', location: 'page 18' },
  ], 'instructions.pdf')
  assert.equal(critical.questions.deadlines.length, 1)
  assert.equal(critical.questions.submissionInstructions.length, 1)
  assert.equal(critical.proposals.deadlines.length, 1)
  assert.equal(critical.proposals.submissionInstructions.length, 1)
  assert.deepEqual(critical.proposals.deadlines[0].citation, { fileName: 'instructions.pdf', location: 'page 18' })
})
