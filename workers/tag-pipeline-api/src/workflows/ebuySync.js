import { WorkflowEntrypoint } from 'cloudflare:workers'
import { EBUY_FIXTURE_OPPORTUNITIES } from '../fixtures/ebuyOpportunities.js'
import { finishEbuySyncRun, startEbuySyncRun, syncEbuyOpportunities } from '../lib/ebuyRepository.js'

export async function runEbuySyncWorkflow(env, event, step) {
  if (!env.EBUY_DB) throw new Error('The EBUY_DB binding is unavailable')
  const mode = event.payload?.mode || 'fixture'
  const run = await step.do('Create eBuy sync record', () => startEbuySyncRun(env.EBUY_DB, mode, {
    instanceId: event.instanceId,
  }))
  try {
    const result = await step.do('Synchronize eBuy archive', {
      retries: { limit: 2, delay: '10 seconds', backoff: 'exponential' },
      timeout: '2 minutes',
    }, async () => {
      if (mode !== 'fixture') throw new Error('The live eBuy connector is not enabled')
      return syncEbuyOpportunities(env.EBUY_DB, EBUY_FIXTURE_OPPORTUNITIES, { source: 'fixture', completeSnapshot: true })
    })
    await step.do('Complete eBuy sync record', () => finishEbuySyncRun(env.EBUY_DB, run.id, result))
    return { ok: true, runId: run.id, ...result }
  } catch (error) {
    await step.do('Record eBuy sync failure', () => finishEbuySyncRun(env.EBUY_DB, run.id, {}, error))
    throw error
  }
}

export class EbuySyncWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    return runEbuySyncWorkflow(this.env, event, step)
  }
}

