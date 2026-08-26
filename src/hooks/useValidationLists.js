import { useState, useEffect, useCallback } from 'react'
import { getValidationLists, updateValidationColumn } from '@/services/graphService'
import { forceRefreshCache, invalidateCache, onCacheRefresh } from '@/services/dataCache'

export function useValidationLists({ enabled = true } = {}) {
  const [lists, setLists]   = useState({})
  const [loading, setLoading] = useState(true)
  const [error, setError]   = useState(null)

  const load = useCallback(async ({ silent = false } = {}) => {
    if (!enabled) { setLoading(false); return }
    if (!silent) {
      setLoading(true)
      setError(null)
    }
    try {
      const data = await getValidationLists()
      setLists(data)
    } catch (err) {
      if (!silent) setError(err.message)
    } finally {
      if (!silent) setLoading(false)
    }
  }, [enabled])

  useEffect(() => { load() }, [load])

  useEffect(() => {
    const unsub = onCacheRefresh((tables) => {
      if (tables?.includes('DataValidationTable')) return load({ silent: true })
      return undefined
    })
    return unsub
  }, [load])

  const update = useCallback(async (header, values) => {
    await updateValidationColumn(header, values)
    await invalidateCache(['DataValidationTable'])
  }, [])

  const refresh = useCallback(async () => {
    await forceRefreshCache(['DataValidationTable']).catch(() => {})
    await load()
  }, [load])

  return { lists, loading, error, refresh, update }
}

/**
 * Helper for components: returns the live list for `header` if it has
 * any values, otherwise falls back to `fallback`.
 */
export function pickList(lists, header, fallback) {
  const live = lists?.[header]
  return live && live.length > 0 ? live : fallback
}
