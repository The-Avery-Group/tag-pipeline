import { useState, useEffect, useCallback, useRef } from 'react'
import { getPipeline, addOpportunity, updateOpportunity, deleteOpportunity } from '@/services/graphService'
import { notifyNewOpportunity, notifyPhaseChange } from '@/services/notifyService'
import { invalidateCache, onCacheRefresh } from '@/services/dataCache'

export function usePipeline() {
  const [pipeline, setPipeline] = useState([])
  const [loading, setLoading]   = useState(true)
  const [error, setError]       = useState(null)
  const notifyLock = useRef(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await getPipeline()
      setPipeline(data)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  // Re-load whenever the background poll brings in fresh data
  useEffect(() => {
    const unsub = onCacheRefresh(load)
    return unsub
  }, [load])

  const add = useCallback(async (data) => {
    await addOpportunity(data)
    if (!notifyLock.current) {
      notifyLock.current = true
      notifyNewOpportunity(data).finally(() => { notifyLock.current = false })
    }
    await invalidateCache()   // clears cache + re-fetches all tables
  }, [])

  const update = useCallback(async (rowIndex, patch, original) => {
    const phaseCol = 'TAG Opportunity Phase'
    if (
      patch[phaseCol] && original?.[phaseCol] &&
      patch[phaseCol] !== original[phaseCol] &&
      !notifyLock.current
    ) {
      notifyLock.current = true
      notifyPhaseChange({ ...original, ...patch }, original[phaseCol], patch[phaseCol])
        .finally(() => { notifyLock.current = false })
    }
    await updateOpportunity(rowIndex, patch)
    await invalidateCache()
  }, [])

  const remove = useCallback(async (rowIndex) => {
    await deleteOpportunity(rowIndex)
    await invalidateCache()
  }, [])

  return { pipeline, loading, error, refresh: load, add, update, remove }
}