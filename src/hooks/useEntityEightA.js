import { useEffect, useState } from 'react'
import { WORKER_URL, workerFetch } from '@/services/workerClient'

export function useEntityEightA(uei) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    const normalizedUEI = String(uei || '').trim().toUpperCase()
    if (!/^[A-Z0-9]{12}$/.test(normalizedUEI) || !WORKER_URL) {
      setData(null)
      setLoading(false)
      setError(null)
      return undefined
    }

    const controller = new AbortController()
    const timer = window.setTimeout(async () => {
      setLoading(true)
      setError(null)
      try {
        const response = await workerFetch(`/entities/8a?uei=${encodeURIComponent(normalizedUEI)}`, { signal: controller.signal })
        const result = await response.json()
        if (!response.ok) throw new Error(result.error || `Worker returned ${response.status}`)
        setData(result)
      } catch (error) {
        if (error.name !== 'AbortError') {
          setData(null)
          setError(error.message || '8(a) status lookup unavailable')
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false)
      }
    }, 450)

    return () => {
      controller.abort()
      window.clearTimeout(timer)
    }
  }, [uei])

  return { data, loading, error }
}
