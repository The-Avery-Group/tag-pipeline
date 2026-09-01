import assert from 'node:assert/strict'
import test from 'node:test'

import { addStructuredBriefEvidence, analyzeRelevantChunk, classifyAnalysisSection, consolidateBriefItems, consolidateReadyDocumentRows, criticalAnalysisStatus, DOCUMENT_ANALYSIS_VERSION, documentAnalysisCoverage, documentAnalysisDisplayJob, documentAnalysisWorkspace, extractCitedRequirements, extractCriticalSubmissionDetails, extractDocumentSections, groqRetryDelay, hasResumableAnalysisChunks, isSubmissionTemplateAttachment, manualAnalysisState, OPPORTUNITY_BRIEF_CATEGORIES, reconcileCriticalFindings, relevantAnalysisChunks, resumableAnalysisChunks, validateDocumentAnalysisResponse } from '../src/lib/documentAnalysis.js'

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

test('an abandoned background job becomes restartable instead of processing forever', () => {
  const now = new Date('2026-09-02T12:00:00.000Z')
  const current = { status: 'running', progress_phase: 'Processing documents', updated_at: '2026-09-02T11:58:00.000Z' }
  const abandoned = { ...current, updated_at: '2026-09-02T11:50:00.000Z' }
  assert.equal(documentAnalysisDisplayJob(current, now).status, 'running')
  assert.equal(documentAnalysisDisplayJob(abandoned, now).status, 'error')
  assert.match(documentAnalysisDisplayJob(abandoned, now).progress_phase, /restart/i)
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
  assert.equal(chunks.some((chunk) => Object.values(chunk.referenceLocations || {}).flat().includes('page 160')), true)
  assert.match(combined, /\[S\d{4}\]/)
})

test('Groq pacing honors reset headers without dropping below one minute', () => {
  const response = { headers: { get: (name) => name === 'retry-after' ? '43.275' : name === 'x-ratelimit-reset-tokens' ? '1m 12.5s' : null } }
  assert.equal(groqRetryDelay(response), 73)
  assert.equal(groqRetryDelay({ headers: { get: () => null } }), 60)
})

test('document analysis uses Workers AI with the existing parser output', async () => {
  const calls = []
  const result = await analyzeRelevantChunk({
    AI: {
      run: async (model, input) => {
        calls.push({ model, input })
        return {
          choices: [{ message: { content: JSON.stringify({
            documentType: 'instructions',
            sections: [{ category: 'scope', text: 'The contractor will provide support services.', assessment: 'found', sectionIds: ['S0001'] }],
          }) } }],
        }
      },
    },
    GROQ_API_KEY: 'unused-fallback-key',
  }, {
    source: '[S0001]\nThe contractor shall provide support services.',
    references: { S0001: 'paragraph 1' },
    locations: ['paragraph 1'],
  }, 'solicitation.docx', {})

  assert.equal(result.status, 'ready')
  assert.equal(result.provider, 'workers_ai')
  assert.deepEqual(result.briefSections, [{
    category: 'scope', text: 'The contractor will provide support services.', assessment: 'found', locations: ['paragraph 1'], citations: undefined,
  }])
  assert.equal(calls.length, 1)
  assert.equal(calls[0].model, '@cf/openai/gpt-oss-20b')
  assert.equal(calls[0].input.max_tokens, 2_000)
  assert.equal(calls[0].input.max_completion_tokens, undefined)
  assert.equal(calls[0].input.response_format.type, 'json_schema')
  assert.equal(calls[0].input.response_format.json_schema.type, 'object')
  assert.match(calls[0].input.messages[1].content, /S0001/)
})

test('Groq fallback uses strict structured output when Workers AI cannot complete a chunk', async () => {
  const originalFetch = globalThis.fetch
  let requestBody
  const workersModels = []
  globalThis.fetch = async (_url, request) => {
    requestBody = JSON.parse(request.body)
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({
        model: 'openai/gpt-oss-20b',
        choices: [{ message: { content: JSON.stringify({
          documentType: 'supporting',
          sections: [],
        }) } }],
      }),
    }
  }
  try {
    const result = await analyzeRelevantChunk({
      AI: { run: async (model) => { workersModels.push(model); throw new Error('Workers AI output was truncated') } },
      GROQ_API_KEY: 'test-key',
    }, {
      source: '[S0001]\nThe contractor shall provide support services.',
      references: { S0001: 'paragraph 1' },
      locations: ['paragraph 1'],
    }, 'solicitation.docx', {})

    assert.equal(result.status, 'ready')
    assert.equal(result.provider, 'groq')
    assert.deepEqual(workersModels, ['@cf/openai/gpt-oss-20b', '@cf/openai/gpt-oss-120b'])
    assert.equal(requestBody.max_completion_tokens, 2_000)
    assert.equal(requestBody.response_format.type, 'json_schema')
    assert.equal(requestBody.response_format.json_schema.strict, true)
    assert.equal(requestBody.response_format.json_schema.schema.type, 'object')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('current unreadable chunks are resumed without discarding completed chunks', () => {
  const prior = { version: DOCUMENT_ANALYSIS_VERSION, status: 'ready', chunks: [
    { index: 0, status: 'error', error: 'Groq returned analysis that could not be read', source: 'failed', references: {}, fingerprint: 'failed' },
    { index: 1, status: 'ready', result: { overview: 'Preserved' }, source: 'complete', references: {}, fingerprint: 'complete' },
  ] }
  assert.equal(hasResumableAnalysisChunks(prior), true)
  const chunks = resumableAnalysisChunks(prior, [], {})
  assert.equal(chunks[0].status, 'deferred')
  assert.equal(chunks[0].malformedResponseAttempts, 1)
  assert.equal(chunks[1].status, 'ready')
  assert.equal(chunks[1].result.overview, 'Preserved')
  assert.equal(hasResumableAnalysisChunks({ chunks: [{ status: 'error', malformedResponseAttempts: 3, error: 'Groq: malformed JSON' }] }), false)
  assert.equal(hasResumableAnalysisChunks({
    status: 'ready', coverage: { chunkCount: 13, completedChunks: 11 },
    warnings: ['Groq returned analysis that could not be read'],
  }), true)
})

test('unchanged sections reuse their completed AI result after a document refresh', () => {
  const sections = [
    { location: 'paragraph 12', text: 'The contractor shall submit a monthly status report.' },
  ]
  const [fresh] = relevantAnalysisChunks(sections, {}, 1_200)
  const cachedResult = {
    overview: 'Monthly reporting is required.',
    responseRequirements: [{ text: 'Submit a monthly status report.', location: 'paragraph 12' }],
  }
  const chunks = resumableAnalysisChunks({
    version: DOCUMENT_ANALYSIS_VERSION,
    status: 'ready',
    chunkCache: [{ fingerprint: fresh.fingerprint, result: cachedResult }],
  }, sections, {})

  assert.equal(chunks.length, 1)
  assert.equal(chunks[0].status, 'ready')
  assert.equal(chunks[0].reused, true)
  assert.deepEqual(chunks[0].result, cachedResult)
})

test('document analysis discards unsupported citations without losing the valid chunk', () => {
  const result = validateDocumentAnalysisResponse({
    documentType: 'instructions',
    sections: [
      { category: 'proposal_submission_poc', text: 'Supported instruction', assessment: 'found', sectionIds: ['S0001'] },
      { category: 'proposal_submission_poc', text: 'Invented instruction', assessment: 'found', sectionIds: ['S9999'] },
    ],
  }, { references: { S0001: 'page 1' }, locations: ['page 1'] }, {})
  assert.deepEqual(result.briefSections, [{
    category: 'proposal_submission_poc', text: 'Supported instruction', assessment: 'found', locations: ['page 1'], citations: undefined,
  }])
})

test('AI vocabulary differences are normalized instead of failing the document review', () => {
  const result = validateDocumentAnalysisResponse({
    documentType: 'RFQ',
    sections: [
      { category: 'proposal_submission', text: 'Complete submission instructions.', assessment: 'found', sectionIds: ['S0001'] },
      { category: 'miscellaneous', text: 'No supported citation.', assessment: 'found', sectionIds: [] },
    ],
  }, { references: { S0001: 'page 4 · section “L” · paragraph 80' } }, {})
  assert.equal(result.documentType, 'solicitation')
  assert.deepEqual(result.briefSections, [{
    category: 'proposal_submission_poc', text: 'Complete submission instructions.', assessment: 'found',
    locations: ['page 4 · section “L” · paragraph 80'],
    citations: undefined,
  }])
})

test('opportunity brief consolidates duplicate findings and retains useful citations', () => {
  assert.deepEqual(consolidateBriefItems([
    { category: 'proposal_submission_poc', text: 'Submit the quotation by email.', citations: [{ fileName: 'a.docx', location: 'paragraph 10' }] },
    { category: 'proposal_submission_poc', text: 'Submit the complete quotation by email to bids@example.gov.', citations: [{ fileName: 'a.docx', location: 'paragraph 12' }] },
    { category: 'scope', text: 'Provide help desk support.', citations: [{ fileName: 'a.docx', location: 'paragraph 8' }] },
  ]), [
    { category: 'proposal_submission_poc', text: 'Submit the complete quotation by email to bids@example.gov.', assessment: 'found', citations: [{ fileName: 'a.docx', location: 'paragraph 10' }, { fileName: 'a.docx', location: 'paragraph 12' }] },
    { category: 'scope', text: 'Provide help desk support.', assessment: 'found', citations: [{ fileName: 'a.docx', location: 'paragraph 8' }] },
  ])
})

test('Word citations include rendered page and section context when available', async () => {
  const xml = `<w:document xmlns:w="word"><w:body>
    <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>L. Instructions to Offerors</w:t></w:r></w:p>
    <w:p><w:r><w:t>Introductory text.</w:t></w:r><w:lastRenderedPageBreak/></w:p>
    <w:p><w:r><w:t>Quotations shall be submitted by email.</w:t></w:r></w:p>
  </w:body></w:document>`
  const { zipSync, strToU8 } = await import('fflate')
  const bytes = zipSync({ 'word/document.xml': strToU8(xml) })
  const sections = await extractDocumentSections(bytes, 'solicitation.docx')
  assert.equal(sections[2].location, 'page 2 · section “L. Instructions to Offerors” · paragraph 3')
})

test('available file analysis remains visible when another document fails', () => {
  const result = consolidateReadyDocumentRows([
    {
      file_name: 'instructions.pdf', file_path: 'RFP/instructions.pdf', status: 'ready', summary: 'Fallback summary',
      analysis_json: JSON.stringify({
        documentType: 'instructions', briefSections: [
          { category: 'purpose_overview', text: 'The agency needs support services.', assessment: 'found', locations: ['page 2'] },
          { category: 'evaluation_criteria', text: 'Technical approach is evaluated.', assessment: 'found', locations: ['page 12'] },
        ],
      }),
    },
    { file_name: 'corrupt.pdf', status: 'error', summary: '', analysis_json: '{}' },
  ])
  assert.equal(result.status, 'ready')
  assert.equal(result.coverage.documentCount, 1)
  assert.equal(result.sections.length, 8)
  assert.deepEqual(result.sections.find((section) => section.category === 'purpose_overview').items, [{
    category: 'purpose_overview', text: 'The agency needs support services.', assessment: 'found', citations: [{ fileName: 'instructions.pdf', location: 'page 2' }],
  }])
  assert.deepEqual(result.sections.find((section) => section.category === 'evaluation_criteria').items, [{
    category: 'evaluation_criteria', text: 'Technical approach is evaluated.', assessment: 'found', citations: [{ fileName: 'instructions.pdf', location: 'page 12' }],
  }])
  assert.equal(result.sections.find((section) => section.category === 'scope').status, 'not_found')
})

test('structured posting evidence is added to proposal submission without fabricating other sections', () => {
  const result = addStructuredBriefEvidence(consolidateReadyDocumentRows([]), [{
    text: 'Responses close September 8, 2026 at 1:00 PM ET.',
    citation: { fileName: 'SAM.gov opportunity record', location: 'Response deadline' },
  }])
  assert.deepEqual(result.sections.map((section) => section.category), OPPORTUNITY_BRIEF_CATEGORIES)
  assert.equal(result.sections.find((section) => section.category === 'proposal_submission_poc').status, 'found')
  assert.equal(result.sections.find((section) => section.category === 'scope').status, 'not_found')
})

test('submission templates can be identified for later drafting without excluding their parent folder', () => {
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
  assert.equal(requirements.length, 1)
  assert.deepEqual(requirements[0].citation, { fileName: 'requirements.txt', location: 'section 2' })
  assert.match(requirements[0].text, /shall provide weekly status reports/i)
  assert.match(requirements[0].text, /staffing plan/i)
})

test('standard clauses are skipped while solicitation-specific deviations remain in context', () => {
  assert.deepEqual(classifyAnalysisSection({ text: 'FAR 52.212-4 Contract Terms and Conditions—Commercial Products and Commercial Services.' }), {
    disposition: 'boilerplate', reason: 'recognized_standard_clause',
  })
  assert.equal(classifyAnalysisSection({ text: 'FAR 52.212-4 is tailored by this addendum to require monthly security reporting.' }).disposition, 'analyze')
  const coverage = documentAnalysisCoverage([
    { text: 'FAR 52.212-4 Contract Terms and Conditions—Commercial Products and Commercial Services.', location: 'page 1' },
    { text: 'The offeror shall submit its technical response by email on September 8, 2026.', location: 'page 2' },
    { text: 'Program background and acquisition history.', location: 'page 3' },
  ])
  assert.equal(coverage.boilerplateSections, 1)
  assert.equal(coverage.analyzedSections, 1)
  assert.equal(coverage.referenceSections, 1)
  const chunks = relevantAnalysisChunks([
    { text: 'FAR 52.212-4 Contract Terms and Conditions—Commercial Products and Commercial Services.', location: 'page 1', kind: 'page' },
    { text: 'The offeror shall submit its technical response by email on September 8, 2026.', location: 'page 2', kind: 'page' },
    { text: 'The next page identifies the required technical volumes and attachments.', location: 'page 3', kind: 'page' },
  ])
  assert.doesNotMatch(chunks.map((chunk) => chunk.source).join('\n'), /52\.212-4/)
  assert.match(chunks.map((chunk) => chunk.source).join('\n'), /required technical volumes/i)
})

test('document review ranges retain page, heading, and paragraph precision', () => {
  const [chunk] = relevantAnalysisChunks([
    { text: 'L. Instructions to Offerors', location: 'page 4 · section “L. Instructions to Offerors” · paragraph 80', kind: 'heading', heading: 'L. Instructions to Offerors' },
    { text: 'The offeror shall submit a technical volume.', location: 'page 4 · section “L. Instructions to Offerors” · paragraph 81', kind: 'paragraph', heading: 'L. Instructions to Offerors' },
    { text: 'The technical volume has a 20-page limit.', location: 'page 5 · section “L. Instructions to Offerors” · paragraph 82', kind: 'paragraph', heading: 'L. Instructions to Offerors' },
  ])
  assert.deepEqual(Object.values(chunk.references), ['pages 4–5 · section “L. Instructions to Offerors” · paragraphs 80–82'])
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
