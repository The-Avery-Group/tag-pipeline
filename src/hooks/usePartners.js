import { useState, useEffect, useCallback, useRef } from 'react'
import { getPartners, addPartner, updatePartner, deletePartner } from '@/services/graphService'
import { invalidateCache, onCacheRefresh } from '@/services/dataCache'

export function usePartners() {
  const [partners, setPartners] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const pendingPatches = useRef(new Map())

  const load = useCallback(async ({ silent = false } = {}) => {
    if (!silent) {
      setLoading(true)
      setError(null)
    }
    try {
      const data = await getPartners()
      setPartners(data.map((partner) => {
        const patch = pendingPatches.current.get(partner._rowIndex)
        if (!patch) return partner
        const confirmed = Object.keys(patch).every((key) => partner[key] === patch[key])
        if (confirmed) pendingPatches.current.delete(partner._rowIndex)
        return confirmed ? partner : { ...partner, ...patch }
      }))
    } catch (err) {
      if (!silent) setError(err.message)
    } finally {
      if (!silent) setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])
  // The workbook's shared poll is still respected, but it must never turn a
  // visible partner profile back into a loading state or interrupt editing.
  useEffect(() => onCacheRefresh(() => load({ silent: true })), [load])

  const add = useCallback(async (data) => {
    await addPartner(data)
    await invalidateCache()
  }, [])

  const update = useCallback(async (rowIndex, patch, original) => {
    pendingPatches.current.set(rowIndex, patch)
    setPartners((current) => current.map((partner) =>
      partner._rowIndex === rowIndex ? { ...partner, ...patch } : partner
    ))
    try {
      await updatePartner(rowIndex, patch)
      await invalidateCache()
    } catch (err) {
      pendingPatches.current.delete(rowIndex)
      setPartners((current) => current.map((partner) =>
        partner._rowIndex === rowIndex ? original : partner
      ))
      throw err
    }
  }, [])

  const remove = useCallback(async (rowIndex, original) => {
    setPartners((current) => current.filter((partner) => partner._rowIndex !== rowIndex))
    try {
      await deletePartner(rowIndex)
      await invalidateCache()
    } catch (err) {
      setPartners((current) => [...current, original].sort((a, b) => a._rowIndex - b._rowIndex))
      throw err
    }
  }, [])

  return { partners, loading, error, refresh: load, add, update, remove }
}
