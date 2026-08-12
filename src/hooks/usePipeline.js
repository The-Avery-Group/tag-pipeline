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

export function usePipeline() {
  const [pipeline, setPipeline] = useState([])
  const [loading, setLoading]   = useState(true)
  const [error, setError]       = useState(null)
  const notifyLock = useRef(false)
  const pipelineRef = useRef([])

  useEffect(() => { pipelineRef.current = pipeline }, [pipeline])

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
        const identity = String(opp['Contract Number / Notice ID'] || '').trim()
        const patch = pendingPatches.current.get(identity)
        if (!patch) return opp
        const confirmed = Object.keys(patch).every((k) => opp[k] === patch[k])
        if (confirmed) {
          pendingPatches.current.delete(identity)
          return opp
        }
        return { ...opp, ...patch }
      })
      setPipeline(reconciled)
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
    setPipeline((current) => current.some((item) =>
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
    const identity = String(original?.['Contract Number / Notice ID'] || '').trim()
    if (identity) pendingPatches.current.set(identity, patch)

    // Optimistic update — apply patch to local state immediately so
    // the UI reflects the change before the API call completes
    setPipeline((prev) =>
      prev.map((opp) =>
        opp._rowIndex === rowIndex ? { ...opp, ...patch } : opp
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
      setPipeline((prev) =>
        prev.map((opp) =>
          opp._rowIndex === rowIndex ? { ...opp, ...original } : opp
        )
      )
      throw err
    }
  }, [])

  const remove = useCallback(async (rowIndex) => {
    const original = pipelineRef.current.find((opportunity) => opportunity._rowIndex === rowIndex)
    setPipeline((current) => current.filter((opportunity) => opportunity._rowIndex !== rowIndex))
    try {
      await retryIdempotent(() => deleteOpportunity(rowIndex, original))
      await publishCacheUpdate(['PipelineTable'])
      verifyCacheInBackground(['PipelineTable'])
    } catch (error) {
      await load()
      throw error
    }
  }, [load])

  const refresh = useCallback(async () => {
    await forceRefreshCache(['PipelineTable']).catch(() => {})
    await load()
  }, [load])

  return { pipeline, loading, error, refresh, add, update, remove }
}
