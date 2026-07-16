import { useEffect, useState } from 'react'

const WORKER_URL = import.meta.env.VITE_API_BASE_URL

export function useEntityEightA(uei) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    const normalizedUEI = String(uei || '').trim().toUpperCase()
    if (!/^[A-Z0-9]{12}$/.test(normalizedUEI) || !WORKER_URL) {
      setData(null)
      setLoading(false)
      return undefined
    }

    const controller = new AbortController()
    const timer = window.setTimeout(async () => {
      setLoading(true)
      try {
        const response = await fetch(`${WORKER_URL}/entities/8a?uei=${encodeURIComponent(normalizedUEI)}`, { signal: controller.signal })
        const result = await response.json()
        if (!response.ok) throw new Error(result.error || `Worker returned ${response.status}`)
        setData(result)
      } catch (error) {
        if (error.name !== 'AbortError') setData(null)
      } finally {
        if (!controller.signal.aborted) setLoading(false)
      }
    }, 450)

    return () => {
      controller.abort()
      window.clearTimeout(timer)
    }
  }, [uei])

  return { data, loading }
}
