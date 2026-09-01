import { useCallback, useEffect, useState } from 'react'
import { getOpportunityRelationships } from '@/services/graphService'
import { onCacheRefresh } from '@/services/dataCache'

export function useCrmRelationships(enabled = true) {
  const [relationships, setRelationships] = useState([])
  const [loading, setLoading] = useState(Boolean(enabled))
  const [error, setError] = useState(null)

  const load = useCallback(async ({ silent = false } = {}) => {
    if (!enabled) {
      setLoading(false)
      return
    }
    if (!silent) setLoading(true)
    try {
      setRelationships(await getOpportunityRelationships())
      setError(null)
    } catch (err) {
      if (!silent) setError(err.message)
    } finally {
      if (!silent) setLoading(false)
    }
  }, [enabled])

  useEffect(() => { load() }, [load])
  useEffect(() => onCacheRefresh((tables) => {
    if (tables?.includes('OpportunityRelationshipsTable')) return load({ silent: true })
    return undefined
  }), [load])

  return { relationships, loading, error }
}
