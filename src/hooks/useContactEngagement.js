import { useCallback, useEffect, useState } from 'react'
import {
  addContactInteraction,
  getContactInteractions,
} from '@/services/graphService'
import { forceRefreshCache, invalidateCache, onCacheRefresh } from '@/services/dataCache'

export function useContactEngagement(enabled = false) {
  const [interactions, setInteractions] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const load = useCallback(async ({ silent = false } = {}) => {
    if (!silent) {
      setLoading(true)
      setError(null)
    }
    try {
      setInteractions(await getContactInteractions())
    } catch (err) {
      setInteractions(null)
      if (!silent) setError(err.message)
    } finally {
      if (!silent) setLoading(false)
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
    return onCacheRefresh((tables) => {
      if (tables?.includes('ContactInteractionsTable')) return load({ silent: true })
      return undefined
    })
  }, [enabled, load])

  const addInteraction = useCallback(async (data) => {
    const saved = await addContactInteraction(data)
    // Show the newly logged interaction immediately. The background refresh
    // below reconciles this optimistic entry with the workbook afterwards.
    setInteractions((current) => [...(current || []), saved])
    await invalidateCache(['ContactInteractionsTable'])
    return saved
  }, [])

  const refresh = useCallback(async () => {
    await forceRefreshCache(['ContactInteractionsTable']).catch(() => {})
    await load()
  }, [load])

  return {
    interactions: interactions || [],
    interactionsConfigured: interactions !== null,
    loading,
    error,
    refresh,
    addInteraction,
  }
}
