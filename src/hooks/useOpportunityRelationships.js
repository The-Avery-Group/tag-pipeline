import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  deleteOpportunityRelationship,
  getOpportunityRelationships,
  linkRelatedOpportunities,
  migrateLegacyOpportunityRelationships,
  updateOpportunityRelationshipType,
} from '@/services/graphService'
import { forceRefreshCache, publishCacheUpdate } from '@/services/dataCache'
import { shareRelatedOpportunityWorkspace } from '@/services/opportunityWorkspaceService'

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

  const link = useCallback(async (relatedOpportunity, createdBy = '', relationshipType = 'Related only') => {
    await linkRelatedOpportunities(
      { opportunityId, createdBy, relationshipType },
      { opportunityId: relatedOpportunity['Opportunity ID'], createdBy },
    )
    await forceRefreshCache(['OpportunityRelationshipsTable']).catch(() => {})
    await load()
    await publishCacheUpdate(['OpportunityRelationshipsTable'])
    const current = pipeline.find((item) => String(item['Opportunity ID'] || '').trim() === opportunityId)
    const leftKey = String(current?.['Contract Number / Notice ID'] || '').trim()
    const rightKey = String(relatedOpportunity?.['Contract Number / Notice ID'] || '').trim()
    let workspaceWarning = ''
    if (relationshipType === 'Follow-on' && leftKey && rightKey) {
      try { await shareRelatedOpportunityWorkspace(leftKey, rightKey, relationshipType) }
      catch (error) { workspaceWarning = error.message }
    }
    return { workspaceWarning }
  }, [opportunityId, pipeline, load])

  const organizeWorkspace = useCallback(async (relatedOpportunity) => {
    const current = pipeline.find((item) => String(item['Opportunity ID'] || '').trim() === opportunityId)
    const leftKey = String(current?.['Contract Number / Notice ID'] || '').trim()
    const rightKey = String(relatedOpportunity?.['Contract Number / Notice ID'] || '').trim()
    if (!leftKey || !rightKey) throw new Error('Both opportunities need a contract or notice identifier')
    return shareRelatedOpportunityWorkspace(leftKey, rightKey, 'Follow-on')
  }, [opportunityId, pipeline])

  const unlink = useCallback(async (relationship) => {
    await deleteOpportunityRelationship(relationship._rowIndex, relationship)
    await load()
    await publishCacheUpdate(['OpportunityRelationshipsTable'])
  }, [load])

  const updateType = useCallback(async (relationship, relationshipType) => {
    await updateOpportunityRelationshipType(relationship._rowIndex, relationship, relationshipType)
    await load()
    await publishCacheUpdate(['OpportunityRelationshipsTable'])
    if (relationshipType === 'Follow-on' && relationship.opportunity) await organizeWorkspace(relationship.opportunity)
  }, [load, organizeWorkspace])

  return { relationships, loading, error, link, unlink, updateType, organizeWorkspace, refresh: load }
}
