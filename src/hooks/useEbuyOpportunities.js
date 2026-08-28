import { useCallback, useEffect, useRef, useState } from 'react'
import {
  getEbuyStatus,
  listEbuyOpportunities,
  startEbuyLiveSync,
  updateEbuyOpportunityState,
} from '@/services/ebuyService'

const listCache = new Map()
let statusCache = null

function listCacheKey({ search, type, state, includeDismissed }) {
  return JSON.stringify([search, type, state, Boolean(includeDismissed)])
}

export function useEbuyOpportunities({ search = '', type = 'all', state = 'all', includeDismissed = false } = {}) {
  const key = listCacheKey({ search, type, state, includeDismissed })
  const [data, setData] = useState(() => listCache.get(key) || { opportunities: [], total: 0 })
  const [status, setStatus] = useState(statusCache)
  const [loading, setLoading] = useState(() => !listCache.has(key))
  const [error, setError] = useState(null)
  const [startingSync, setStartingSync] = useState(false)
  const requestRef = useRef(0)
  const terminalRunRef = useRef(null)
  const requestedSyncAtRef = useRef(0)

  const load = useCallback(async ({ silent = false } = {}) => {
    const request = ++requestRef.current
    if (!silent) setLoading(true)
    try {
      const [nextData, nextStatus] = await Promise.all([
        listEbuyOpportunities({ search, type, state, includeDismissed }),
        getEbuyStatus(),
      ])
      if (request !== requestRef.current) return
      setData(nextData)
      setStatus(nextStatus)
      listCache.set(key, nextData)
      statusCache = nextStatus
      setError(null)
    } catch (loadError) {
      if (request === requestRef.current) setError(loadError)
    } finally {
      if (request === requestRef.current && !silent) setLoading(false)
    }
  }, [includeDismissed, key, search, state, type])

  useEffect(() => {
    const cached = listCache.get(key)
    if (cached) {
      setData(cached)
      setStatus(statusCache)
      setLoading(false)
    } else {
      setLoading(true)
    }
    const timer = window.setTimeout(() => load({ silent: Boolean(cached) }), search ? 220 : 0)
    return () => window.clearTimeout(timer)
  }, [key, load, search])

  useEffect(() => {
    if (status?.lastSync?.status !== 'running') return undefined
    let disposed = false
    const refreshProgress = async () => {
      try {
        const nextStatus = await getEbuyStatus()
        if (disposed) return
        const requestedAt = requestedSyncAtRef.current
        const observedStartedAt = new Date(nextStatus?.lastSync?.started_at || 0).getTime()
        // Workflow creation is asynchronous. The first status read can still
        // contain the previous terminal run; keep the optimistic running state
        // until D1 exposes the run that this button just started.
        if (
          requestedAt &&
          nextStatus?.lastSync?.status !== 'running' &&
          observedStartedAt < requestedAt &&
          Date.now() - requestedAt < 30_000
        ) return
        if (nextStatus?.lastSync?.status === 'running' && observedStartedAt >= requestedAt) {
          requestedSyncAtRef.current = 0
        }
        setStatus(nextStatus)
        statusCache = nextStatus
        const run = nextStatus?.lastSync
        if (run && ['success', 'error'].includes(run.status) && terminalRunRef.current !== run.id) {
          terminalRunRef.current = run.id
          await load({ silent: true })
        }
      } catch {
        // Keep the last known progress visible through a temporary status-read failure.
      }
    }
    const timer = window.setInterval(refreshProgress, 2000)
    return () => { disposed = true; window.clearInterval(timer) }
  }, [load, status?.lastSync?.status])

  const synchronize = useCallback(async () => {
    if (startingSync || status?.lastSync?.status === 'running') return { alreadyRunning: true }
    setStartingSync(true)
    setError(null)
    requestedSyncAtRef.current = Date.now()
    try {
      const result = await startEbuyLiveSync()
      setStatus((current) => {
        const next = {
          ...(current || {}),
          lastSync: {
            ...(current?.lastSync || {}),
            id: result.instanceId || current?.lastSync?.id,
            status: 'running',
            started_at: new Date().toISOString(),
            progress: { phase: 'preparing', percent: 2, message: result.alreadyRunning ? 'Joining the active eBuy synchronization' : 'Preparing eBuy synchronization' },
          },
        }
        statusCache = next
        return next
      })
      return result
    } catch (error) {
      requestedSyncAtRef.current = 0
      throw error
    } finally {
      setStartingSync(false)
    }
  }, [startingSync, status?.lastSync?.status])

  const updateState = useCallback(async (requestId, reviewState, pipelineContractId = null) => {
    const previous = data.opportunities.find((item) => item.requestId === requestId) || null
    setData((current) => {
      const next = {
        ...current,
        opportunities: current.opportunities.map((item) => item.requestId === requestId
        ? { ...item, reviewState, pipelineContractId: pipelineContractId || item.pipelineContractId }
        : item),
      }
      listCache.set(key, next)
      return next
    })
    try {
      const result = await updateEbuyOpportunityState(requestId, reviewState, pipelineContractId)
      setData((current) => {
        const next = {
          ...current,
          opportunities: current.opportunities.map((item) => item.requestId === requestId ? result.opportunity : item),
        }
        listCache.set(key, next)
        return next
      })
      return result.opportunity
    } catch (updateError) {
      setData((current) => {
        const next = {
          ...current,
          opportunities: previous
            ? current.opportunities.map((item) => item.requestId === requestId ? previous : item)
            : current.opportunities,
        }
        listCache.set(key, next)
        return next
      })
      throw updateError
    }
  }, [data.opportunities, key])

  return {
    ...data, status, loading, error,
    syncing: startingSync || status?.lastSync?.status === 'running',
    refresh: load, synchronize, updateState,
  }
}
