import assert from 'node:assert/strict'
import test from 'node:test'

import { consolidateReadyDocumentRows, criticalAnalysisStatus, documentAnalysisWorkspace, extractCitedRequirements, extractCriticalSubmissionDetails, extractDocumentSections, groqRetryDelay, isSubmissionTemplateAttachment, manualAnalysisState, reconcileCriticalFindings, relevantAnalysisChunks } from '../src/lib/documentAnalysis.js'

test('pipeline analysis is rooted in the opportunity RFI documents folder', () => {
  const scoped = documentAnalysisWorkspace({ rootFolderId: 'workspace-root', samFolderId: 'rfi-documents', title: 'Example' })
  assert.equal(scoped.rootFolderId, 'rfi-documents')
  assert.equal(scoped.title, 'Example')
  assert.throws(() => documentAnalysisWorkspace({ rootFolderId: 'workspace-root' }), /missing its source-documents folder/)
})

test('completed analysis without critical evidence reports not found instead of searching', () => {
  assert.equal(criticalAnalysisStatus({ status: 'complete' }, [], { questions: {}, proposals: {} }), 'not_found')
  assert.equal(criticalAnalysisStatus({ status: 'queued' }, [], { questions: {}, proposals: {} }), 'processing')
  assert.equal(criticalAnalysisStatus({ status: 'running' }, [], { questions: {}, proposals: {} }), 'processing')
  assert.equal(criticalAnalysisStatus({ status: 'partial' }, [], { questions: {}, proposals: {} }), 'partial')
  assert.equal(criticalAnalysisStatus({ status: 'error' }, [], { questions: {}, proposals: {} }), 'error')
  assert.equal(criticalAnalysisStatus(null, [], { questions: {}, proposals: {} }), 'not_analyzed')
})

test('manual analysis never represents remaining work as an automatic queue', () => {
  assert.deepEqual(manualAnalysisState({ remaining: 0, deferred: 0 }, { status: 'ready' }), {
    completed: true, status: 'complete', progressPhase: 'Analysis available',
  })
  assert.equal(manualAnalysisState({ remaining: 4, deferred: 0 }, { status: 'pending' }).status, 'partial')
  assert.match(manualAnalysisState({ remaining: 4, deferred: 0 }, { status: 'pending' }).progressPhase, /click Analyze documents again/)
  assert.match(manualAnalysisState({ remaining: 0, deferred: 1 }, { status: 'deferred' }).progressPhase, /AI validation paused/)
  assert.deepEqual(manualAnalysisState({ remaining: 4, deferred: 1 }, { status: 'deferred' }, { background: true }), {
    completed: false, status: 'running', progressPhase: 'Processing documents',
  })
})

test('relevant analysis chunks cover late document evidence without truncating it', () => {
  const sections = [
    { location: 'page 1', text: `The contractor shall provide alpha reporting. ${'A'.repeat(760)}` },
    { location: 'page 80', text: `The contractor shall provide beta reporting. ${'B'.repeat(760)}` },
    { location: 'page 160', text: `The contractor shall provide final reporting. ${'C'.repeat(760)}` },
  ]
  const chunks = relevantAnalysisChunks(sections, {}, 1_200)
  assert.ok(chunks.length >= 3)
  const combined = chunks.map((chunk) => chunk.source).join('\n')
  assert.match(combined, /alpha reporting/)
  assert.match(combined, /beta reporting/)
  assert.match(combined, /final reporting/)
  assert.match(combined, /page 160/)
})

test('Groq pacing honors reset headers without dropping below one minute', () => {
  const response = { headers: { get: (name) => name === 'retry-after' ? '43.275' : name === 'x-ratelimit-reset-tokens' ? '1m 12.5s' : null } }
  assert.equal(groqRetryDelay(response), 73)
  assert.equal(groqRetryDelay({ headers: { get: () => null } }), 60)
})

test('available file analysis remains visible when another document fails', () => {
  const result = consolidateReadyDocumentRows([
    {
      file_name: 'instructions.pdf', status: 'ready', summary: 'Fallback summary',
      analysis_json: JSON.stringify({ overview: 'The agency needs support services.', evaluation: [{ text: 'Technical approach is evaluated.', location: 'page 12' }] }),
    },
    { file_name: 'corrupt.pdf', status: 'error', summary: '', analysis_json: '{}' },
  ])
  assert.equal(result.status, 'ready')
  assert.equal(result.coverage.documentCount, 1)
  assert.match(result.overview, /agency needs support services/i)
  assert.deepEqual(result.evaluation, [{ text: 'Technical approach is evaluated.', location: 'page 12', fileName: 'instructions.pdf' }])
})

test('submission templates are excluded by the attachment itself, not its SharePoint parent folder', () => {
  assert.equal(isSubmissionTemplateAttachment({ name: 'Technical_Response_Template.docx', path: '2. RFI Documents/Technical_Response_Template.docx' }), true)
  assert.equal(isSubmissionTemplateAttachment({ name: 'Pricing Schedule.xlsx' }), true)
  assert.equal(isSubmissionTemplateAttachment({ name: 'Solicitation.docx', path: 'Templates/Solicitation.docx' }, [{ text: 'The contractor shall provide support services.' }]), false)
  assert.equal(isSubmissionTemplateAttachment({ name: 'Attachment 3.xlsx' }, [
    { text: 'Offeror name: [insert offeror name]' },
    { text: 'Complete and return this worksheet. Proposed price: ________' },
  ]), true)
})

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
  assert.equal(critical.proposals.deadlines[0].confidence, 0.96)
  assert.equal(critical.proposals.deadlines[0].verification, 'deterministic')
})

test('critical scan does not treat an answer-posting date as the questions deadline', () => {
  const critical = extractCriticalSubmissionDetails([
    { text: 'Responses to vendor questions will be posted by September 12, 2026.', location: 'page 4' },
  ], 'questions-and-answers.pdf')
  assert.deepEqual(critical.questions.deadlines, [])
})

test('critical scan does not treat late-offer boilerplate as a proposal submission method', () => {
  const critical = extractCriticalSubmissionDetails([{
    text: 'Any offer received after the time specified for receipt of offers is late and will not be considered unless the Contracting Officer determines otherwise.',
    location: 'paragraph 1132',
  }], 'solicitation.docx')
  assert.deepEqual(critical.proposals.submissionInstructions, [])
})

test('critical scan recognizes day-month-year proposal deadlines', () => {
  const critical = extractCriticalSubmissionDetails([{
    text: 'Quotations are due no later than 08 September 2026, 1:00 PM Eastern Time.',
    location: 'paragraph 1166',
  }], 'solicitation.docx')
  assert.equal(critical.proposals.deadlines.length, 1)
})

test('critical scan marks tentative and historical dates as low confidence', () => {
  const critical = extractCriticalSubmissionDetails([
    { text: 'The draft schedule estimated that proposals were due September 18, 2025.', location: 'page 1' },
  ], 'market-research.pdf')
  assert.equal(critical.proposals.deadlines.length, 1)
  assert.equal(critical.proposals.deadlines[0].confidence, 0.55)
})

test('critical scan preserves separate table rows and their citations', () => {
  const critical = extractCriticalSubmissionDetails([
    { text: 'Questions must be sent by October 2, 2026 at 4:00 PM ET to bids@example.gov.\nProposals must be uploaded through PIEE by October 16, 2026 at 4:00 PM ET.', location: 'table 3' },
  ], 'Amendment 0002.docx')
  assert.equal(critical.questions.deadlines.length, 1)
  assert.equal(critical.proposals.deadlines.length, 1)
  assert.equal(critical.questions.deadlines[0].amendmentNumber, 2)
  assert.equal(critical.proposals.deadlines[0].citation.location, 'table 3')
})

test('current amendment evidence outranks an older structured deadline and exposes the conflict', () => {
  const result = reconcileCriticalFindings([{
    questions: { deadlines: [], submissionInstructions: [] },
    proposals: { deadlines: [{
      text: 'Amendment 0002 extends the proposal deadline to October 16, 2026 at 4:00 PM ET.',
      citation: { fileName: 'Amendment 0002.pdf', location: 'page 1' },
      confidence: 0.96,
      verification: 'ai_validated',
      sourceRank: 502,
      amendmentNumber: 2,
      supersedesPrior: true,
    }], submissionInstructions: [] },
  }], [{
    text: 'Responses are due October 9, 2026 according to the current SAM.gov opportunity record.',
    citation: { fileName: 'SAM.gov opportunity record', location: 'Response deadline' },
    category: 'proposals.deadlines',
    confidence: 1,
    verification: 'structured_source',
    sourceRank: 450,
  }])

  assert.match(result.proposals.deadlines[0].text, /October 16/)
  assert.equal(result.conflicts.length, 1)
  assert.match(result.conflicts[0].alternatives[0].text, /October 9/)
})

test('low-confidence tentative dates are excluded from displayed critical findings', () => {
  const result = reconcileCriticalFindings([{
    questions: { deadlines: [], submissionInstructions: [] },
    proposals: { deadlines: [{
      text: 'The tentative proposal deadline is October 16, 2026.',
      citation: { fileName: 'draft.pdf', location: 'page 1' },
      confidence: 0.55,
      verification: 'deterministic',
      sourceRank: 150,
    }], submissionInstructions: [] },
  }])

  assert.deepEqual(result.proposals.deadlines, [])
})

test('unvalidated deterministic candidates are never displayed as critical facts', () => {
  const result = reconcileCriticalFindings([{
    questions: { deadlines: [{
      text: 'Questions are due August 28, 2026 at 1:00 PM ET.',
      citation: { fileName: 'solicitation.docx', location: 'paragraph 1176' },
      confidence: 0.96,
      verification: 'deterministic',
      sourceRank: 400,
    }], submissionInstructions: [] },
    proposals: { deadlines: [], submissionInstructions: [] },
  }])
  assert.deepEqual(result.questions.deadlines, [])
})

test('corroborating sources with the same deadline are not reported as a conflict', () => {
  const result = reconcileCriticalFindings([{
    questions: { deadlines: [], submissionInstructions: [] },
    proposals: { deadlines: [{
      text: 'Proposals must be received by October 16, 2026 at 4:00 PM ET.',
      citation: { fileName: 'instructions.pdf', location: 'page 5' },
      confidence: 0.96,
      verification: 'ai_validated',
      sourceRank: 400,
    }], submissionInstructions: [] },
  }], [{
    text: 'Responses close October 16, 2026 at 4:00 PM ET in GSA eBuy.',
    citation: { fileName: 'GSA eBuy opportunity record', location: 'Closing date' },
    category: 'proposals.deadlines',
    confidence: 1,
    verification: 'structured_source',
    sourceRank: 450,
  }])

  assert.equal(result.proposals.deadlines.length, 2)
  assert.deepEqual(result.conflicts, [])
})

test('ISO and day-month deadline formats reconcile as the same fact', () => {
  const result = reconcileCriticalFindings([{
    questions: { deadlines: [], submissionInstructions: [] },
    proposals: { deadlines: [{
      text: 'Quotations are due no later than 08 September 2026, 1:00 PM Eastern Time.',
      citation: { fileName: 'solicitation.docx', location: 'paragraph 1166' },
      confidence: 0.96,
      verification: 'ai_validated',
      sourceRank: 400,
    }], submissionInstructions: [] },
  }], [{
    text: 'Responses are due 2026-09-08T13:00:00-04:00 according to the current SAM.gov opportunity record.',
    citation: { fileName: 'SAM.gov opportunity record', location: 'Response deadline' },
    category: 'proposals.deadlines', confidence: 1, verification: 'structured_source', sourceRank: 450,
  }])
  assert.equal(result.proposals.deadlines.length, 2)
  assert.deepEqual(result.conflicts, [])
})
