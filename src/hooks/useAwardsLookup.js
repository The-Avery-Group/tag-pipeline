import { useState, useCallback, useEffect, useRef } from 'react'

const WORKER_URL = import.meta.env.VITE_API_BASE_URL

/**
 * useAwardsLookup
 *
 * Looks up SAM.gov Contract Award data via the Worker's /awards/lookup
 * endpoint. Each result is a source-aware current snapshot: every displayed
 * field is resolved explicitly from the most recent valid SAM transaction,
 * while the latest modification remains separate.
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
  const [cache, setCache]       = useState(null)
  const inFlightLookupRef       = useRef(null)
  const abortControllerRef      = useRef(null)
  const requestSequenceRef      = useRef(0)

  const lookup = useCallback(({ piid, solicitationID, forceRefresh = false } = {}) => {
    if (!piid && !solicitationID) return
    if (!WORKER_URL) { setError('VITE_API_BASE_URL not set'); return }

    const params = new URLSearchParams()
    if (piid) params.set('piid', piid)
    if (solicitationID) params.set('solicitationID', solicitationID)
    if (forceRefresh) params.set('refresh', '1')
    const requestKey = params.toString()
    if (inFlightLookupRef.current?.key === requestKey) return inFlightLookupRef.current.promise
    const requestSequence = ++requestSequenceRef.current

    // A new search must replace the previous view immediately. Aborting the
    // former request and checking its sequence also prevent a slow response
    // from restoring an older contract after the user has searched again.
    abortControllerRef.current?.abort()
    const controller = new AbortController()
    abortControllerRef.current = controller
    setResults([])
    setCache(null)
    setSearched(false)

    const request = (async () => {
      setLoading(true)
      setError(null)
      try {

        const res = await fetch(`${WORKER_URL}/awards/lookup?${params}`, { signal: controller.signal })
        const data = await res.json()

        if (!res.ok) throw new Error(data.error || `Worker returned ${res.status}`)

        if (requestSequence !== requestSequenceRef.current) return
        setResults(data.results || [])
        setCache(data.cache || null)
        setSearched(true)
      } catch (err) {
        if (err.name === 'AbortError' || requestSequence !== requestSequenceRef.current) return
        setError(err.message)
        setResults([])
        setCache(null)
        setSearched(true)
      } finally {
        if (requestSequence === requestSequenceRef.current) setLoading(false)
      }
    })()
    inFlightLookupRef.current = { key: requestKey, promise: request }
    request.finally(() => {
      if (inFlightLookupRef.current?.promise === request) inFlightLookupRef.current = null
    })
    return request
  }, [])

  const reset = useCallback(() => {
    requestSequenceRef.current += 1
    abortControllerRef.current?.abort()
    abortControllerRef.current = null
    setResults([])
    setError(null)
    setSearched(false)
    setCache(null)
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

  return { results, loading, error, searched, cache, lookup, reset }
}
