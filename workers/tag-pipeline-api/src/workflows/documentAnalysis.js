import { WorkflowEntrypoint } from 'cloudflare:workers'
import {
  failDocumentAnalysisJob,
  runDocumentAnalysis,
  runEbuyArchiveDocumentAnalysis,
  runSAMArchiveDocumentAnalysis,
} from '../lib/documentAnalysis.js'

const MAX_ANALYSIS_CHECKPOINTS = 500

async function runCheckpoint(env, payload) {
  const options = { background: true }
  if (payload.source === 'sam') return runSAMArchiveDocumentAnalysis(env, payload.input || { opportunityKey: payload.opportunityKey }, options)
  if (payload.source === 'ebuy') return runEbuyArchiveDocumentAnalysis(env, payload.opportunityKey, options)
  return runDocumentAnalysis(env, payload.opportunityKey, options)
}

export async function runDocumentAnalysisWorkflow(env, event, step) {
  const payload = event.payload || {}
  const opportunityKey = String(payload.opportunityKey || '').trim().toLowerCase()
  if (!env.EBUY_DB || !opportunityKey) return { ok: false, error: 'Document analysis metadata is unavailable' }
  try {
    for (let checkpoint = 0; checkpoint < MAX_ANALYSIS_CHECKPOINTS; checkpoint += 1) {
      const result = await step.do(`Process document analysis checkpoint ${checkpoint + 1}`, {
        retries: { limit: 3, delay: '60 seconds', backoff: 'exponential' },
        timeout: '10 minutes',
      }, () => runCheckpoint(env, payload))
      if (result.cancelled) return { ok: true, cancelled: true }
      if (result.state?.completed) return { ok: true, status: 'complete', opportunityKey }

      // Never expose provider capacity timing to users. The Workflow sleeps
      // durably and the page continues to show a single Processing state.
      const delay = Math.max(1, Number(result.nextDelaySeconds || 0))
      await step.sleep(`Pace document analysis checkpoint ${checkpoint + 1}`, `${Math.ceil(delay)} seconds`)
    }
    throw new Error('Document analysis exceeded its safe checkpoint limit')
  } catch (error) {
    await step.do('Record document analysis failure', () => failDocumentAnalysisJob(env.EBUY_DB, opportunityKey, error)).catch(() => {})
    console.warn(JSON.stringify({ event: 'document_analysis_workflow_failed', opportunityKey, message: error.message }))
    return { ok: false, error: error.message }
  }
}

export class DocumentAnalysisWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    return runDocumentAnalysisWorkflow(this.env, event, step)
  }
}
