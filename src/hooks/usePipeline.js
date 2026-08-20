import { useState, useEffect, useCallback, useRef } from 'react'
import { getPipeline, addOpportunity, updateOpportunity, deleteOpportunity } from '@/services/graphService'
import { notifyNewOpportunity, notifyPhaseChange } from '@/services/notifyService'
import {
  forceRefreshCache,
  onCacheRefresh,
  publishCacheUpdate,
  verifyCacheInBackground,
} from '@/services/dataCache'
import { retryIdempotent } from '@/services/workbookMutations'
import { requestOpportunityWorkspace } from '@/services/opportunityWorkspaceService'
import { unlinkEbuyPipelineOpportunity } from '@/services/ebuyService'
import { useAuth } from '@/auth/AuthContext'

const isArchived = (opportunity) => /^(yes|true|1)$/i.test(String(opportunity?.Archived || '').trim())
const opportunityIdentity = (opportunity) => String(
  opportunity?.['Opportunity ID'] || opportunity?.['Contract Number / Notice ID'] || ''
).trim()

export function usePipeline() {
  const { user } = useAuth()
  const [records, setRecords] = useState([])
  const [loading, setLoading]   = useState(true)
  const [error, setError]       = useState(null)
  const notifyLock = useRef(false)
  const pipelineRef = useRef([])

  const pipeline = records.filter((opportunity) => !isArchived(opportunity))
  const archivedPipeline = records.filter(isArchived)

  useEffect(() => { pipelineRef.current = records }, [records])

  // Tracks in-flight field patches not yet confirmed by a server read, so a
  // racing refresh (background poll, or any other hook's invalidateCache())
  // can't clobber an edit before the write has actually landed. Keyed by
  // stable opportunity ID -> patch object.
  const pendingPatches = useRef(new Map())

  const load = useCallback(async ({ silent = false } = {}) => {
    if (!silent) {
      setLoading(true)
      setError(null)
    }
    try {
      const data = await getPipeline()
      const reconciled = data.map((opp) => {
        const identity = opportunityIdentity(opp)
        const patch = pendingPatches.current.get(identity)
        if (!patch) return opp
        const confirmed = Object.keys(patch).every((k) => opp[k] === patch[k])
        if (confirmed) {
          pendingPatches.current.delete(identity)
          return opp
        }
        return { ...opp, ...patch }
      })
      setRecords(reconciled)
    } catch (err) {
      if (!silent) setError(err.message)
    } finally {
      if (!silent) setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  // Re-load whenever the background poll brings in fresh data
  useEffect(() => {
    const unsub = onCacheRefresh((tables) => {
      if (tables?.includes('PipelineTable')) return load({ silent: true })
      return undefined
    })
    return unsub
  }, [load])

  const add = useCallback(async (data) => {
    const saved = await addOpportunity(data)
    const identifier = saved['Contract Number / Notice ID']
    setRecords((current) => current.some((item) =>
      item['Contract Number / Notice ID'] === identifier
    ) ? current : [...current, saved])
    if (!saved._alreadyExisted && !notifyLock.current) {
      notifyLock.current = true
      notifyNewOpportunity(saved).finally(() => { notifyLock.current = false })
    }
    await publishCacheUpdate(['PipelineTable'])
    verifyCacheInBackground(['PipelineTable'])
    if (!saved._alreadyExisted) {
      await requestOpportunityWorkspace(saved, {
        noticeId: data?._workspaceNoticeId || '',
        solicitationNumber: data?._workspaceSolicitationNumber || data?.['Solicitation Number'] || '',
      }).catch((error) => console.warn('[Opportunity workspace] Setup could not start:', error.message))
    }
    return saved
  }, [])

  const update = useCallback(async (rowIndex, patch, original) => {
    const phaseCol = 'TAG Opportunity Phase'
    const identity = opportunityIdentity(original)
    if (identity) pendingPatches.current.set(identity, patch)

    // Optimistic update — apply patch to local state immediately so
    // the UI reflects the change before the API call completes
    setRecords((prev) =>
      prev.map((opp) =>
        opportunityIdentity(opp) === identity ? { ...opp, ...patch } : opp
      )
    )

    if (
      patch[phaseCol] && original?.[phaseCol] &&
      patch[phaseCol] !== original[phaseCol] &&
      !notifyLock.current
    ) {
      notifyLock.current = true
      notifyPhaseChange({ ...original, ...patch }, original[phaseCol], patch[phaseCol])
        .finally(() => { notifyLock.current = false })
    }

    try {
      await retryIdempotent(() => updateOpportunity(rowIndex, patch, original))
      await publishCacheUpdate(['PipelineTable'])
      verifyCacheInBackground(['PipelineTable'])
    } catch (err) {
      // Roll back optimistic update on failure
      if (identity) pendingPatches.current.delete(identity)
      setRecords((prev) =>
        prev.map((opp) =>
          opportunityIdentity(opp) === identity ? { ...opp, ...original } : opp
        )
      )
      throw err
    }
  }, [])

  const archive = useCallback(async (rowIndex, reason = '') => {
    const original = pipelineRef.current.find((opportunity) => opportunity._rowIndex === rowIndex)
    if (!original) throw new Error('The opportunity could not be located')
    const patch = {
      Archived: 'Yes',
      'Archived At': new Date().toISOString(),
      'Archived By': user?.displayName || user?.email || '',
      'Archive Reason': String(reason || '').trim(),
    }
    const identity = opportunityIdentity(original)
    setRecords((current) => current.map((opportunity) =>
      opportunityIdentity(opportunity) === identity ? { ...opportunity, ...patch } : opportunity
    ))
    try {
      await retryIdempotent(() => updateOpportunity(rowIndex, patch, original))
      await publishCacheUpdate(['PipelineTable'])
      verifyCacheInBackground(['PipelineTable'])
    } catch (error) {
      await load()
      throw error
    }
  }, [load, user])

  const restore = useCallback(async (rowIndex) => {
    const original = pipelineRef.current.find((opportunity) => opportunity._rowIndex === rowIndex)
    if (!original) throw new Error('The opportunity could not be located')
    const patch = { Archived: '', 'Archived At': '', 'Archived By': '', 'Archive Reason': '' }
    const identity = opportunityIdentity(original)
    setRecords((current) => current.map((opportunity) =>
      opportunityIdentity(opportunity) === identity ? { ...opportunity, ...patch } : opportunity
    ))
    try {
      await retryIdempotent(() => updateOpportunity(rowIndex, patch, original))
      await publishCacheUpdate(['PipelineTable'])
      verifyCacheInBackground(['PipelineTable'])
    } catch (error) {
      await load()
      throw error
    }
  }, [load])

  const permanentRemove = useCallback(async (rowIndex) => {
    const original = pipelineRef.current.find((opportunity) => opportunity._rowIndex === rowIndex)
    setRecords((current) => current.filter((opportunity) => opportunity._rowIndex !== rowIndex))
    try {
      await retryIdempotent(() => deleteOpportunity(rowIndex, original))
      await publishCacheUpdate(['PipelineTable'])
      verifyCacheInBackground(['PipelineTable'])
      const identifier = String(original?.['Contract Number / Notice ID'] || '').trim()
      if (identifier) unlinkEbuyPipelineOpportunity(identifier).catch(() => {})
    } catch (error) {
      await load()
      throw error
    }
  }, [load])

  const refresh = useCallback(async () => {
    await forceRefreshCache(['PipelineTable']).catch(() => {})
    await load()
  }, [load])

  return {
    pipeline,
    archivedPipeline,
    allPipeline: records,
    loading,
    error,
    refresh,
    add,
    update,
    archive,
    remove: archive,
    restore,
    permanentRemove,
  }
}
