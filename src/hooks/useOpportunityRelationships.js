import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  deleteOpportunityRelationship,
  getOpportunityRelationships,
  linkRelatedOpportunities,
  migrateLegacyOpportunityRelationships,
} from '@/services/graphService'
import { forceRefreshCache, publishCacheUpdate } from '@/services/dataCache'

export function useOpportunityRelationships(opportunityId = '', pipeline = [], enabled = true) {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(Boolean(enabled))
  const [error, setError] = useState(null)

  const load = useCallback(async () => {
    if (!enabled || !opportunityId) {
      setRows([])
      setLoading(false)
      return
    }
    setLoading(true)
    try {
      setRows(await getOpportunityRelationships())
      setError(null)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [enabled, opportunityId])

  useEffect(() => { load() }, [load])

  useEffect(() => {
    if (!enabled || !opportunityId || !pipeline.length) return
    migrateLegacyOpportunityRelationships(pipeline)
      .then((count) => { if (count) load() })
      .catch(() => {})
  }, [enabled, opportunityId, pipeline, load])

  const relationships = useMemo(() => rows.flatMap((row) => {
    const left = String(row['Opportunity ID'] || '').trim()
    const right = String(row['Related Opportunity ID'] || '').trim()
    const relatedId = left === opportunityId ? right : right === opportunityId ? left : ''
    if (!relatedId) return []
    const opportunity = pipeline.find((item) => String(item['Opportunity ID'] || '').trim() === relatedId)
    return [{ ...row, relatedId, opportunity }]
  }), [rows, opportunityId, pipeline])

  const link = useCallback(async (relatedOpportunity, createdBy = '') => {
    await linkRelatedOpportunities(
      { opportunityId, createdBy },
      { opportunityId: relatedOpportunity['Opportunity ID'], createdBy },
    )
    await forceRefreshCache(['OpportunityRelationshipsTable']).catch(() => {})
    await load()
    await publishCacheUpdate(['OpportunityRelationshipsTable'])
  }, [opportunityId, load])

  const unlink = useCallback(async (relationship) => {
    await deleteOpportunityRelationship(relationship._rowIndex, relationship)
    await load()
    await publishCacheUpdate(['OpportunityRelationshipsTable'])
  }, [load])

  return { relationships, loading, error, link, unlink, refresh: load }
}
