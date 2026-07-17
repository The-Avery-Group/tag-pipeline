import { useCallback, useEffect, useState } from 'react'
import { getEntityAwardHistory } from '@/services/usaSpendingService'

export function useEntityAwardHistory(uei, yearType, group, { enabled = true, includeSubcontracts = false } = {}) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const load = useCallback(async (signal, { forceRefresh = false } = {}) => {
    const normalized = String(uei || '').trim().toUpperCase()
    if (!enabled || !/^[A-Z0-9]{12}$/.test(normalized)) { setData(null); return }
    setLoading(true); setError(null)
    try {
      setData(await getEntityAwardHistory({ uei: normalized, yearType, group, signal, forceRefresh, includeSubcontracts }))
    } catch (err) {
      if (err?.name === 'AbortError') return
      const message = err?.message === 'Failed to fetch'
        ? 'Could not reach USAspending. Please retry.'
        : err.message
      setError(message)
    } finally { setLoading(false) }
  }, [enabled, group, includeSubcontracts, uei, yearType])
  useEffect(() => {
    const controller = new AbortController()
    load(controller.signal)
    return () => controller.abort()
  }, [load])
  return { data, loading, error, refresh: () => load(undefined, { forceRefresh: true }) }
}
