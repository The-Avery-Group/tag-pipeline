import { useCallback, useEffect, useRef, useState } from 'react'
import {
  getEbuyStatus,
  listEbuyOpportunities,
  startEbuyFixtureSync,
  updateEbuyOpportunityState,
} from '@/services/ebuyService'

export function useEbuyOpportunities({ search = '', type = 'all', state = 'all', includeDismissed = false, page = 1 } = {}) {
  const [data, setData] = useState({ opportunities: [], total: 0, totalPages: 1, page: 1 })
  const [status, setStatus] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [syncing, setSyncing] = useState(false)
  const requestRef = useRef(0)

  const load = useCallback(async ({ silent = false } = {}) => {
    const request = ++requestRef.current
    if (!silent) setLoading(true)
    try {
      const [nextData, nextStatus] = await Promise.all([
        listEbuyOpportunities({ search, type, state, includeDismissed, page }),
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
  }, [includeDismissed, page, search, state, type])

  useEffect(() => {
    const timer = window.setTimeout(() => load(), search ? 220 : 0)
    return () => window.clearTimeout(timer)
  }, [load, search])

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

  const syncFixture = useCallback(async () => {
    if (syncing) return
    setSyncing(true)
    setError(null)
    const startedAt = Date.now()
    try {
      await startEbuyFixtureSync()
      for (let attempt = 0; attempt < 30; attempt++) {
        await new Promise((resolve) => window.setTimeout(resolve, 1000))
        const nextStatus = await getEbuyStatus()
        setStatus(nextStatus)
        const lastStarted = Date.parse(nextStatus.lastSync?.started_at || 0)
        if (lastStarted >= startedAt - 2000 && ['success', 'error'].includes(nextStatus.lastSync?.status)) {
          if (nextStatus.lastSync.status === 'error') throw new Error(nextStatus.lastSync.error_message || 'Test archive sync failed')
          await load({ silent: true })
          return nextStatus
        }
      }
      throw new Error('The test sync is still running. Its status will remain available after you leave this page.')
    } finally {
      setSyncing(false)
    }
  }, [load, syncing])

  return { ...data, status, loading, error, syncing, refresh: load, syncFixture, updateState }
}

