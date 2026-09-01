import { WorkflowEntrypoint } from 'cloudflare:workers'
import {
  beginParserEvaluationRun,
  failParserEvaluationRun,
  processNextParserEvaluationDocument,
} from '../lib/parserEvaluation.js'

const MAX_DOCUMENTS_PER_RUN = 72

export class ParserEvaluationWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    const runId = String(event.payload?.runId || '').trim()
    if (!runId || !this.env.EBUY_DB) return { ok: false, error: 'Parser-evaluation metadata is unavailable' }
    try {
      await step.do('Start parser evaluation', () => beginParserEvaluationRun(this.env, runId))
      for (let index = 0; index < MAX_DOCUMENTS_PER_RUN; index += 1) {
        const progress = await step.do(`Compare parser output ${index + 1}`, {
          retries: { limit: 2, delay: '30 seconds', backoff: 'exponential' },
          timeout: '10 minutes',
        }, () => processNextParserEvaluationDocument(this.env, runId))
        if (progress.completed) return { ok: true, runId, processed: progress.processed }
      }
      throw new Error('Parser evaluation exceeded its safe document limit')
    } catch (error) {
      await step.do('Record parser evaluation failure', () => failParserEvaluationRun(this.env, runId, error)).catch(() => {})
      console.warn(JSON.stringify({ event: 'parser_evaluation_failed', runId, message: error.message }))
      return { ok: false, runId, error: error.message }
    }
  }
}
