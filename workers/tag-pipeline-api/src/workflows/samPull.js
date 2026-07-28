import { WorkflowEntrypoint } from 'cloudflare:workers'
import { runScheduledSAMPull } from '../handlers/sam.js'
import { runSAMPullWorkflowCheckpoint } from './samPullChain.js'

export class SAMPullWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    const result = await runSAMPullWorkflowCheckpoint({
      env: this.env,
      event,
      step,
      runCheckpoint: runScheduledSAMPull,
    })

    return result
  }
}
