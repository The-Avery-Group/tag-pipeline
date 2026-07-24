import { useCallback, useEffect, useRef, useState } from 'react'
import { WORKER_URL, workerFetch } from '@/services/workerClient'


/**
 * Looks for RFP/RFQ notices that follow a specific RFI/Sources-Sought record.
 * The Worker applies the strict organization, POC-email, and title-overlap
 * checks; this hook only owns request state and automatic initial lookup.
 */
export function useRfiFollowUps(criteria, { enabled = true } = {}) {
  const [matches, setMatches] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [searched, setSearched] = useState(false)
  const lastKey = useRef(null)

  const lookup = useCallback(async ({ force = false } = {}) => {
    const { department, agency, pocEmail, title, noticeId, submissionDate } = criteria || {}
    if (!enabled || !department || !agency || !pocEmail || !title) return
    if (!WORKER_URL) {
      setError('VITE_API_BASE_URL not set')
      return
    }

    const params = new URLSearchParams({
      department, agency, pocEmail, title, noticeId: noticeId || '', submissionDate: submissionDate || '',
    })
    const key = params.toString()
    if (!force && lastKey.current === key) return
    lastKey.current = key
    setLoading(true)
    setError(null)
    try {
      const res = await workerFetch(`/sam/follow-ups?${params}`)
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || `Worker returned ${res.status}`)
      setMatches(data.matches || [])
      setSearched(true)
    } catch (err) {
      setError(err.message)
      setMatches([])
      setSearched(true)
    } finally {
      setLoading(false)
    }
  }, [criteria, enabled])

  useEffect(() => { lookup() }, [lookup])

  return { matches, loading, error, searched, refresh: () => lookup({ force: true }) }
}
