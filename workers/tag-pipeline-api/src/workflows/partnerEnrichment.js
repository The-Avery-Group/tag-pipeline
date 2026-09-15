import { WorkflowEntrypoint } from 'cloudflare:workers'
import { runPartnerEnrichment } from '../lib/partnerEnrichment.js'

export class PartnerEnrichmentWorkflow extends WorkflowEntrypoint {
  async run(event, step) { return runPartnerEnrichment(this.env, event, step) }
}
