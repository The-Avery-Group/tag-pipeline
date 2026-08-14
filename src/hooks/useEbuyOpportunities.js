import { useCallback, useEffect, useRef, useState } from 'react'
import {
  getEbuyStatus,
  listEbuyOpportunities,
  startEbuyLiveSync,
  updateEbuyOpportunityState,
} from '@/services/ebuyService'

export function useEbuyOpportunities({ search = '', type = 'all', state = 'all', includeDismissed = false } = {}) {
  const [data, setData] = useState({ opportunities: [], total: 0 })
  const [status, setStatus] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [startingSync, setStartingSync] = useState(false)
  const requestRef = useRef(0)
  const terminalRunRef = useRef(null)

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
      setError(null)
    } catch (loadError) {
      if (request === requestRef.current) setError(loadError)
    } finally {
      if (request === requestRef.current && !silent) setLoading(false)
    }
  }, [includeDismissed, search, state, type])

  useEffect(() => {
    const timer = window.setTimeout(() => load(), search ? 220 : 0)
    return () => window.clearTimeout(timer)
  }, [load, search])

  useEffect(() => {
    if (status?.lastSync?.status !== 'running') return undefined
    let disposed = false
    const refreshProgress = async () => {
      try {
        const nextStatus = await getEbuyStatus()
        if (disposed) return
        setStatus(nextStatus)
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
    try {
      const result = await startEbuyLiveSync()
      setStatus((current) => ({
        ...(current || {}),
        lastSync: {
          ...(current?.lastSync || {}),
          status: 'running',
          started_at: new Date().toISOString(),
          progress: { phase: 'preparing', percent: 2, message: result.alreadyRunning ? 'Joining the active eBuy synchronization' : 'Preparing eBuy synchronization' },
        },
      }))
      return result
    } finally {
      setStartingSync(false)
    }
  }, [startingSync, status?.lastSync?.status])

  const updateState = useCallback(async (requestId, reviewState, pipelineContractId = null) => {
    const previous = data.opportunities
    setData((current) => ({
      ...current,
      opportunities: current.opportunities.map((item) => item.requestId === requestId
        ? { ...item, reviewState, pipelineContractId: pipelineContractId || item.pipelineContractId }
        : item),
    }))
    try {
      const result = await updateEbuyOpportunityState(requestId, reviewState, pipelineContractId)
      setData((current) => ({
        ...current,
        opportunities: current.opportunities.map((item) => item.requestId === requestId ? result.opportunity : item),
      }))
      return result.opportunity
    } catch (updateError) {
      setData((current) => ({ ...current, opportunities: previous }))
      throw updateError
    }
  }, [data.opportunities])

  return {
    ...data, status, loading, error,
    syncing: startingSync || status?.lastSync?.status === 'running',
    refresh: load, synchronize, updateState,
  }
}
