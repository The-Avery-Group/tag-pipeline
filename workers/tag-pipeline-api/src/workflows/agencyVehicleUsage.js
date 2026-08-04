import { WorkflowEntrypoint } from 'cloudflare:workers'
import {
  aggregateVehicleOrders,
  currentFiveFiscalYears,
  fetchAgencyUsagePage,
  finalizeVehicleUsage,
  hasMoreAgencyUsagePages,
  resolveVehicleAwards,
  writeAgencyUsageResult,
  writeAgencyUsageRun,
} from '../handlers/agencyIntelligence.js'

// Leave enough of the Free-plan subrequest budget for progress writes,
// continuation, and parent-IDV name resolution in the final instance.
const PAGES_PER_INSTANCE = 25
const PAGE_BATCH_SIZE = 5

function continuationId() {
  return `agency-vehicles-${crypto.randomUUID()}`
}

export class AgencyVehicleUsageWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    try {
      return await this.execute(event, step)
    } catch (error) {
      const key = event?.payload?.key
      if (key) {
        await step.do('Record agency vehicle aggregation failure', async () => {
          await writeAgencyUsageRun(this.env, key, {
            status: 'error',
            instanceId: event.instanceId,
            error: 'USAspending could not finish the agency vehicle aggregate. Try refreshing the data.',
            failedAt: new Date().toISOString(),
          })
        }).catch(() => {})
      }
      console.error(JSON.stringify({
        event: 'agency_vehicle_usage_workflow',
        status: 'error',
        instanceId: event?.instanceId,
        agency: event?.payload?.agency?.name,
        message: error?.message || 'Unknown error',
      }))
      throw error
    }
  }

  async execute(event, step) {
    const payload = event?.payload || {}
    const agency = payload.agency
    const scope = payload.scope === 'awarding' ? 'awarding' : 'funding'
    const key = payload.key
    const resolveOnly = Boolean(payload.resolveOnly)
    let page = Math.max(1, Number(payload.page) || 1)
    let processedOrders = Math.max(0, Number(payload.processedOrders) || 0)
    let aggregate = payload.aggregate || {}
    let totalOrders = Number(payload.totalOrders) || null
    let reachedEnd = false
    const startedAt = payload.startedAt || new Date().toISOString()
    const finalPage = page + PAGES_PER_INSTANCE - 1

    await step.do('Record agency vehicle aggregation start', async () => {
      await writeAgencyUsageRun(this.env, key, {
        status: 'running',
        phase: resolveOnly ? 'resolving' : 'loading',
        instanceId: event.instanceId,
        processedOrders,
        totalOrders,
        page: Math.max(0, page - 1),
        startedAt,
      })
    })

    while (!resolveOnly && page <= finalPage && !reachedEnd) {
      const batchEnd = Math.min(page + PAGE_BATCH_SIZE - 1, finalPage)
      const batchPages = Array.from({ length: batchEnd - page + 1 }, (_, index) => page + index)
      const responses = await Promise.all(batchPages.map((currentPage) => step.do(
        `Load agency order page ${currentPage}`,
        {
          retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' },
          timeout: '3 minutes',
        },
        async () => fetchAgencyUsagePage(agency, scope, currentPage),
      )))

      let lastProcessedPage = page - 1
      for (let index = 0; index < responses.length; index += 1) {
        const response = responses[index]
        const rows = response?.results || []
        aggregate = aggregateVehicleOrders(rows, aggregate)
        processedOrders += rows.length
        lastProcessedPage = batchPages[index]
        if (!hasMoreAgencyUsagePages(response)) {
          reachedEnd = true
          break
        }
      }
      page = lastProcessedPage + 1
      if (reachedEnd) totalOrders = processedOrders

      await step.do(`Record agency vehicle progress ${lastProcessedPage}`, async () => {
        await writeAgencyUsageRun(this.env, key, {
          status: 'running',
          phase: 'loading',
          instanceId: event.instanceId,
          processedOrders,
          totalOrders,
          page: lastProcessedPage,
          totalPages: reachedEnd ? lastProcessedPage : null,
          startedAt,
        })
      })
    }

    const hasNext = !resolveOnly && !reachedEnd
    if (hasNext) {
      const nextInstanceId = continuationId()
      await step.do('Continue agency vehicle aggregation', async () => {
        await this.env.AGENCY_VEHICLE_WORKFLOW.create({
          id: nextInstanceId,
          params: { agency, scope, key, page, aggregate, processedOrders, totalOrders, startedAt },
          retention: { successRetention: '1 day', errorRetention: '3 days' },
        })
        await writeAgencyUsageRun(this.env, key, {
          status: 'running',
          phase: 'loading',
          instanceId: nextInstanceId,
          processedOrders,
          totalOrders,
          page: page - 1,
          totalPages: null,
          startedAt,
        })
      })
      return { status: 'continuing', nextInstanceId, processedOrders, totalOrders }
    }

    if (!resolveOnly) {
      const nextInstanceId = continuationId()
      await step.do('Schedule parent vehicle resolution', async () => {
        await this.env.AGENCY_VEHICLE_WORKFLOW.create({
          id: nextInstanceId,
          params: { agency, scope, key, aggregate, processedOrders, totalOrders: processedOrders, resolveOnly: true, startedAt },
          retention: { successRetention: '1 day', errorRetention: '3 days' },
        })
        await writeAgencyUsageRun(this.env, key, {
          status: 'running',
          phase: 'resolving',
          instanceId: nextInstanceId,
          processedOrders,
          totalOrders: processedOrders,
          startedAt,
        })
      })
      return { status: 'resolving', nextInstanceId, processedOrders, totalOrders: processedOrders }
    }

    const resolutions = await step.do(
      'Resolve parent vehicle records',
      {
        retries: { limit: 2, delay: '10 seconds', backoff: 'exponential' },
        timeout: '5 minutes',
      },
      async () => resolveVehicleAwards(Object.keys(aggregate)),
    )
    const usage = finalizeVehicleUsage(aggregate, resolutions)
    const period = currentFiveFiscalYears()
    const result = {
      agency,
      scope,
      period,
      ...usage,
      processedOrders,
      unlinkedOrders: Math.max(0, processedOrders - usage.totals.orders),
      fetchedAt: new Date().toISOString(),
      source: 'USAspending.gov',
    }

    await step.do('Save agency vehicle aggregate', async () => {
      await writeAgencyUsageResult(this.env, key, result)
    })
    return { status: 'ready', vehicles: result.totals.vehicles, orders: result.totals.orders }
  }
}
