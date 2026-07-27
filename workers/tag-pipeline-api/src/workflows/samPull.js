import { WorkflowEntrypoint } from 'cloudflare:workers'
import { runScheduledSAMPull } from '../handlers/sam.js'

const MAX_CHECKPOINTS = 1000
const PERMANENT_ERROR = /not configured|does not contain any NAICS|API key expired|API key invalid/i

function cursorKey(cursor) {
  return `${Number(cursor?.naicsIndex) || 0}:${Number(cursor?.offset) || 0}`
}

export class SAMPullWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    let continuation = null

    for (let checkpoint = 1; checkpoint <= MAX_CHECKPOINTS; checkpoint++) {
      const priorCursor = continuation?.nextCursor
      const outcome = await step.do(
        `SAM pull checkpoint ${checkpoint}`,
        {
          retries: {
            limit: 3,
            delay: '10 seconds',
            backoff: 'exponential',
          },
          timeout: '5 minutes',
        },
        async () => {
          const result = await runScheduledSAMPull(this.env, continuation)
          if (!result.ok && !result.skipped && !PERMANENT_ERROR.test(result.error || '')) {
            throw new Error(result.error || 'Scheduled SAM checkpoint failed')
          }
          return result
        },
      )

      if (!outcome.ok || outcome.skipped) {
        console.error(JSON.stringify({
          event: 'scheduled_sam_pull_workflow',
          status: outcome.skipped ? 'skipped' : 'error',
          instanceId: event.instanceId,
          checkpoint,
          message: outcome.message || outcome.error || 'Unknown error',
        }))
        return outcome
      }

      const pull = outcome.result
      if (pull.status !== 'partial') {
        console.log(JSON.stringify({
          event: 'scheduled_sam_pull_workflow',
          status: 'complete',
          instanceId: event.instanceId,
          checkpoints: checkpoint,
          runId: pull.runId,
          totalFetched: pull.totalFetched,
          totalWritten: pull.totalWritten,
          completedAt: pull.completedAt,
        }))
        return {
          ok: true,
          status: 'complete',
          checkpoints: checkpoint,
          runId: pull.runId,
          totalFetched: pull.totalFetched,
          totalWritten: pull.totalWritten,
          completedAt: pull.completedAt,
        }
      }

      if (priorCursor && cursorKey(priorCursor) === cursorKey(pull.nextCursor)) {
        throw new Error(`Scheduled SAM pull did not advance beyond checkpoint ${cursorKey(priorCursor)}`)
      }

      continuation = pull
      await step.sleep(`SAM checkpoint pause ${checkpoint}`, '1 second')
    }

    throw new Error(`Scheduled SAM pull exceeded ${MAX_CHECKPOINTS} checkpoints`)
  }
}
