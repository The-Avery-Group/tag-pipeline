import { useCallback, useEffect, useState } from 'react'

const WORKER_URL = import.meta.env.VITE_API_BASE_URL

export function useEntityAwardHistory(uei, yearType, group) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const load = useCallback(async () => {
    const normalized = String(uei || '').trim().toUpperCase()
    if (!WORKER_URL || !/^[A-Z0-9]{12}$/.test(normalized)) { setData(null); return }
    setLoading(true); setError(null)
    try {
      const params = new URLSearchParams({ uei: normalized, yearType, group })
      const response = await fetch(`${WORKER_URL}/entities/award-history?${params}`)
      const result = await response.json()
      if (!response.ok) throw new Error(result.error || 'Could not load award history')
      setData(result)
    } catch (err) { setError(err.message) } finally { setLoading(false) }
  }, [group, uei, yearType])
  useEffect(() => { load() }, [load])
  return { data, loading, error, refresh: load }
}
