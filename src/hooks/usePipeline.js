import { useState, useEffect, useCallback } from 'react'
import { getPipeline, addOpportunity, updateOpportunity, deleteOpportunity } from '@/services/graphService'
import { notifyNewOpportunity, notifyPhaseChange } from '@/services/notifyService'

export function usePipeline() {
  const [pipeline, setPipeline] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

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

  const add = useCallback(async (data) => {
    await addOpportunity(data)
    await notifyNewOpportunity(data)
    await load()
  }, [load])

  const update = useCallback(async (rowIndex, patch, original) => {
    const phaseCol = 'TAG Opportunity Phase'
    if (patch[phaseCol] && original?.[phaseCol] && patch[phaseCol] !== original[phaseCol]) {
      await notifyPhaseChange({ ...original, ...patch }, original[phaseCol], patch[phaseCol])
    }
    await updateOpportunity(rowIndex, patch)
    await load()
  }, [load])

  const remove = useCallback(async (rowIndex) => {
    await deleteOpportunity(rowIndex)
    await load()
  }, [load])

  return { pipeline, loading, error, refresh: load, add, update, remove }
}
