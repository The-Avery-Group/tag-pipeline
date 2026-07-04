import { useState, useCallback, useEffect, useRef } from 'react'

const WORKER_URL = import.meta.env.VITE_API_BASE_URL

/**
 * useAwardsLookup
 *
 * Looks up SAM.gov Contract Award data via the Worker's /awards/lookup
 * endpoint. Each result is already a composite "current state" record —
 * modification history has been merged server-side (see the Worker's
 * awards.js) — so consumers don't need to think about mods at all.
 *
 * Usage — auto-fire for a known opportunity (OpportunityDetail):
 *   const { results, loading, error } = useAwardsLookup({ piid: contractNumber, auto: true })
 *
 * Usage — manual trigger for an arbitrary search (Lookup tab):
 *   const { results, loading, error, lookup } = useAwardsLookup()
 *   <button onClick={() => lookup({ piid: input, solicitationID: input })}>Search</button>
 */
export function useAwardsLookup({ piid: autoPiid, solicitationID: autoSolicitationID, auto = false } = {}) {
  const [results, setResults]   = useState([])
  const [loading, setLoading]   = useState(false)
  const [error, setError]       = useState(null)
  const [searched, setSearched] = useState(false)   // distinguishes "never searched" from "searched, found nothing"

  const lookup = useCallback(async ({ piid, solicitationID } = {}) => {
    if (!piid && !solicitationID) return
    if (!WORKER_URL) { setError('VITE_API_BASE_URL not set'); return }

    setLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams()
      if (piid) params.set('piid', piid)
      if (solicitationID) params.set('solicitationID', solicitationID)

      const res = await fetch(`${WORKER_URL}/awards/lookup?${params}`)
      const data = await res.json()

      if (!res.ok) throw new Error(data.error || `Worker returned ${res.status}`)

      setResults(data.results || [])
      setSearched(true)
    } catch (err) {
      setError(err.message)
      setResults([])
    } finally {
      setLoading(false)
    }
  }, [])

  const reset = useCallback(() => {
    setResults([])
    setError(null)
    setSearched(false)
  }, [])

  // Auto-fire once for a known identifier (OpportunityDetail's use case).
  // Re-fires if the identifier itself changes — guards via a ref rather
  // than assuming the component remounts on navigation, since React Router
  // can reuse a component instance across param changes on the same route.
  const lastAutoKey = useRef(null)
  useEffect(() => {
    if (!auto) return
    if (!autoPiid && !autoSolicitationID) return
    const key = `${autoPiid || ''}:${autoSolicitationID || ''}`
    if (lastAutoKey.current === key) return
    lastAutoKey.current = key
    lookup({ piid: autoPiid, solicitationID: autoSolicitationID })
  }, [auto, autoPiid, autoSolicitationID, lookup])

  return { results, loading, error, searched, lookup, reset }
}
