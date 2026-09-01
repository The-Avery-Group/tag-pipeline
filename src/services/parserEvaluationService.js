import { workerJson } from '@/services/workerClient'

export function getParserEvaluationAccess() {
  return workerJson('/parser-evaluation/access', { cache: 'no-store' })
}

export function getParserEvaluationReport(runId = '') {
  const query = runId ? `?runId=${encodeURIComponent(runId)}` : ''
  return workerJson(`/parser-evaluation/report${query}`, { cache: 'no-store' })
}

export function startParserEvaluation(input = {}) {
  return workerJson('/parser-evaluation/runs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
}

export function reviewParserEvaluationDocument(documentId, decision, notes = '') {
  return workerJson(`/parser-evaluation/documents/${encodeURIComponent(documentId)}/review`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ decision, notes }),
  })
}
