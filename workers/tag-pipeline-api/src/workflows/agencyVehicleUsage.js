import { WorkflowEntrypoint } from 'cloudflare:workers'
import {
  aggregateVehicleOrders,
  clearAgencyUsageWorkingState,
  currentFiveFiscalYears,
  fetchAgencyUsagePage,
  finalizeVehicleUsage,
  hasMoreAgencyUsagePages,
  readAgencyUsageCheckpoint,
  readAgencyUsageResolutions,
  resolveVehicleAwards,
  writeAgencyUsageCheckpoint,
  writeAgencyUsageResolutions,
  writeAgencyUsageResult,
  writeAgencyUsageRun,
} from '../handlers/agencyIntelligence.js'

// The free Worker plan allows 50 subrequests per invocation. Five sequential
// order pages leave room for step retries, KV checkpoints, and continuation.
const PAGES_PER_INSTANCE = 5
const RESOLUTIONS_PER_INSTANCE = 150

function continuationId() {
  return `agency-vehicles-${crypto.randomUUID()}`
}

function workflowOptions() {
  return { retention: { successRetention: '1 day', errorRetention: '3 days' } }
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
    if (payload.resolveOnly) return this.resolveVehicles(event, step)

    const agency = payload.agency
    const scope = payload.scope === 'awarding' ? 'awarding' : 'funding'
    const key = payload.key
    const startedAt = payload.startedAt || new Date().toISOString()
    let page = Math.max(1, Number(payload.page) || 1)
    let processedOrders = Math.max(0, Number(payload.processedOrders) || 0)
    let aggregate = await readAgencyUsageCheckpoint(this.env, key)
    let reachedEnd = false
    const finalPage = page + PAGES_PER_INSTANCE - 1

    await step.do('Record agency vehicle aggregation start', async () => {
      await writeAgencyUsageRun(this.env, key, {
        status: 'running',
        phase: 'loading',
        instanceId: event.instanceId,
        processedOrders,
        totalOrders: null,
        page: Math.max(0, page - 1),
        activePage: page,
        startedAt,
      })
    })

    while (page <= finalPage && !reachedEnd) {
      const currentPage = page
      const response = await step.do(
        `Load agency order page ${currentPage}`,
        {
          retries: { limit: 5, delay: '5 seconds', backoff: 'exponential' },
          timeout: '1 minute',
        },
        async () => fetchAgencyUsagePage(agency, scope, currentPage),
      )
      const rows = response?.results || []
      aggregate = aggregateVehicleOrders(rows, aggregate)
      processedOrders += rows.length
      reachedEnd = !hasMoreAgencyUsagePages(response)
      page = currentPage + 1

      await step.do(`Record agency vehicle progress ${currentPage}`, async () => {
        await writeAgencyUsageRun(this.env, key, {
          status: 'running',
          phase: 'loading',
          instanceId: event.instanceId,
          processedOrders,
          totalOrders: reachedEnd ? processedOrders : null,
          page: currentPage,
          activePage: reachedEnd ? null : page,
          totalPages: reachedEnd ? currentPage : null,
          startedAt,
        })
      })
    }

    await step.do('Save agency order checkpoint', async () => {
      await writeAgencyUsageCheckpoint(this.env, key, aggregate)
    })

    if (!reachedEnd) {
      const nextInstanceId = continuationId()
      await step.do('Create agency order continuation', async () => {
        await this.env.AGENCY_VEHICLE_WORKFLOW.create({
          id: nextInstanceId,
          params: { agency, scope, key, page, processedOrders, startedAt },
          ...workflowOptions(),
        })
      })
      await step.do('Point status to agency order continuation', async () => {
        await writeAgencyUsageRun(this.env, key, {
          status: 'running',
          phase: 'loading',
          instanceId: nextInstanceId,
          processedOrders,
          totalOrders: null,
          page: page - 1,
          activePage: page,
          startedAt,
        })
      })
      return { status: 'continuing', nextInstanceId, processedOrders }
    }

    const parentVehicleIds = Object.keys(aggregate)
    const nextInstanceId = continuationId()
    await step.do('Create parent vehicle resolution', async () => {
      await this.env.AGENCY_VEHICLE_WORKFLOW.create({
        id: nextInstanceId,
        params: {
          agency,
          scope,
          key,
          processedOrders,
          totalOrders: processedOrders,
          resolveOnly: true,
          resolveOffset: 0,
          startedAt,
        },
        ...workflowOptions(),
      })
    })
    await step.do('Record parent vehicle resolution start', async () => {
      await writeAgencyUsageRun(this.env, key, {
        status: 'running',
        phase: 'resolving',
        instanceId: nextInstanceId,
        processedOrders,
        totalOrders: processedOrders,
        resolvedVehicles: 0,
        totalVehicles: parentVehicleIds.length,
        startedAt,
      })
    })
    return { status: 'resolving', nextInstanceId, processedOrders, vehicles: parentVehicleIds.length }
  }

  async resolveVehicles(event, step) {
    const payload = event?.payload || {}
    const agency = payload.agency
    const scope = payload.scope === 'awarding' ? 'awarding' : 'funding'
    const key = payload.key
    const startedAt = payload.startedAt || new Date().toISOString()
    const processedOrders = Math.max(0, Number(payload.processedOrders) || 0)
    const aggregate = await readAgencyUsageCheckpoint(this.env, key)
    const parentVehicleIds = Object.keys(aggregate)
    const resolveOffset = Math.max(0, Number(payload.resolveOffset) || 0)
    const resolveEnd = Math.min(parentVehicleIds.length, resolveOffset + RESOLUTIONS_PER_INSTANCE)
    const currentIds = parentVehicleIds.slice(resolveOffset, resolveEnd)
    const resolutions = await readAgencyUsageResolutions(this.env, key)

    if (currentIds.length) {
      const currentResolutions = await step.do(
        `Resolve parent vehicles ${resolveOffset + 1}-${resolveEnd}`,
        {
          retries: { limit: 5, delay: '5 seconds', backoff: 'exponential' },
          timeout: '2 minutes',
        },
        async () => resolveVehicleAwards(currentIds),
      )
      Object.assign(resolutions, currentResolutions)
      await step.do(`Save parent vehicle resolutions through ${resolveEnd}`, async () => {
        await writeAgencyUsageResolutions(this.env, key, resolutions)
      })
    }

    if (resolveEnd < parentVehicleIds.length) {
      const nextInstanceId = continuationId()
      await step.do('Create parent vehicle resolution continuation', async () => {
        await this.env.AGENCY_VEHICLE_WORKFLOW.create({
          id: nextInstanceId,
          params: {
            agency,
            scope,
            key,
            processedOrders,
            totalOrders: processedOrders,
            resolveOnly: true,
            resolveOffset: resolveEnd,
            startedAt,
          },
          ...workflowOptions(),
        })
      })
      await step.do('Record parent vehicle resolution progress', async () => {
        await writeAgencyUsageRun(this.env, key, {
          status: 'running',
          phase: 'resolving',
          instanceId: nextInstanceId,
          processedOrders,
          totalOrders: processedOrders,
          resolvedVehicles: resolveEnd,
          totalVehicles: parentVehicleIds.length,
          startedAt,
        })
      })
      return { status: 'resolving', nextInstanceId, resolvedVehicles: resolveEnd, totalVehicles: parentVehicleIds.length }
    }

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
    await step.do('Clear agency vehicle working state', async () => {
      await clearAgencyUsageWorkingState(this.env, key)
    }).catch((error) => {
      console.warn(JSON.stringify({
        event: 'agency_vehicle_usage_cleanup_failed',
        agency: agency?.name,
        message: error?.message || 'Unknown error',
      }))
    })
    return { status: 'ready', vehicles: result.totals.vehicles, orders: result.totals.orders }
  }
}
