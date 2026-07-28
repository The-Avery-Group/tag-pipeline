import { useCallback, useEffect, useMemo, useState } from 'react'
import { getSAMOpportunities } from '@/services/graphService'
import { WORKER_URL, workerFetch } from '@/services/workerClient'
import { buildSAMOpportunityPatch } from '@/utils/samOpportunityHelpers'

function normalized(value) {
  return String(value || '').trim().toUpperCase()
}

export function useSAMChangeSuggestion(opportunity, columns) {
  const [suggestion, setSuggestion] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  const identity = useMemo(() => [
    normalized(opportunity?.[columns.contractNum]),
    normalized(opportunity?.[columns.solNum]),
  ].filter(Boolean), [columns.contractNum, columns.solNum, opportunity])

  const load = useCallback(async () => {
    if (!WORKER_URL || !opportunity || !identity.length) {
      setSuggestion(null)
      return null
    }
    setLoading(true)
    setError(null)
    try {
      const rows = await getSAMOpportunities()
      const sourceRow = rows.find((row) =>
        identity.includes(normalized(row['Notice ID'])) ||
        identity.includes(normalized(row['Solicitation Number']))
      )
      if (!sourceRow) {
        setSuggestion(null)
        return null
      }
      const statusParams = new URLSearchParams()
      if (sourceRow['Notice ID']) statusParams.set('noticeId', sourceRow['Notice ID'])
      if (sourceRow['Solicitation Number']) statusParams.set('solicitationNumber', sourceRow['Solicitation Number'])
      const response = await workerFetch(`/sam/changes/status?${statusParams.toString()}`)
      if (!response.ok) throw new Error('Could not load the latest SAM change status')
      const status = await response.json()
      const watch = (status.watches || []).find((item) => Number(item.rowIndex) === Number(sourceRow._rowIndex))
      if (!watch?.change || watch.change.reviewedAt || !watch.latest) {
        setSuggestion(null)
        return null
      }
      const { patch, changes } = buildSAMOpportunityPatch(opportunity, watch.latest, columns)
      const next = { sourceRow, watch, patch, changes }
      setSuggestion(next)
      return next
    } catch (loadError) {
      setError(loadError.message || 'Could not load SAM changes')
      return null
    } finally {
      setLoading(false)
    }
  }, [columns, identity, opportunity])

  useEffect(() => { load() }, [load])

  const markReviewed = useCallback(async () => {
    if (!suggestion?.sourceRow) return
    const response = await workerFetch('/sam/changes/review', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(suggestion.sourceRow),
    })
    if (!response.ok) throw new Error('Could not mark the SAM update as reviewed')
    setSuggestion(null)
  }, [suggestion])

  return { suggestion, loading, error, load, markReviewed }
}
