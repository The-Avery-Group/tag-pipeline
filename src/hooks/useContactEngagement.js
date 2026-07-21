import { useCallback, useEffect, useState } from 'react'
import {
  addContactInteraction,
  getContactInteractions,
} from '@/services/graphService'
import { invalidateCache, onCacheRefresh } from '@/services/dataCache'

export function useContactEngagement(enabled = false) {
  const [interactions, setInteractions] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setInteractions(await getContactInteractions())
    } catch (err) {
      setInteractions(null)
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!enabled) {
      setLoading(false)
      return
    }
    load()
  }, [enabled, load])

  useEffect(() => {
    if (!enabled) return undefined
    return onCacheRefresh(load)
  }, [enabled, load])

  const addInteraction = useCallback(async (data) => {
    await addContactInteraction(data)
    await invalidateCache()
  }, [])

  return {
    interactions: interactions || [],
    interactionsConfigured: interactions !== null,
    loading,
    error,
    refresh: load,
    addInteraction,
  }
}
