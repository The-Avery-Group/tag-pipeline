import { useState, useEffect, useCallback } from 'react'
import { getValidationLists, updateValidationColumn } from '@/services/graphService'
import { invalidateCache, onCacheRefresh } from '@/services/dataCache'

export function useValidationLists() {
  const [lists, setLists]   = useState({})
  const [loading, setLoading] = useState(true)
  const [error, setError]   = useState(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await getValidationLists()
      setLists(data)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  useEffect(() => {
    const unsub = onCacheRefresh(load)
    return unsub
  }, [load])

  const update = useCallback(async (header, values) => {
    await updateValidationColumn(header, values)
    await invalidateCache()
  }, [])

  return { lists, loading, error, refresh: load, update }
}

/**
 * Helper for components: returns the live list for `header` if it has
 * any values, otherwise falls back to `fallback`.
 */
export function pickList(lists, header, fallback) {
  const live = lists?.[header]
  return live && live.length > 0 ? live : fallback
}