import { WorkflowEntrypoint } from 'cloudflare:workers'
import { runExpiringContractsRefresh } from '../handlers/expiringContracts.js'

export class ExpiringContractsWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    return runExpiringContractsRefresh(this.env, event, step)
  }
}
