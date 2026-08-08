import { useState, useEffect, useCallback, useRef } from 'react'
import { getPartners, addPartner, updatePartner, deletePartner } from '@/services/graphService'
import {
  forceRefreshCache,
  onCacheRefresh,
  publishCacheUpdate,
  verifyCacheInBackground,
} from '@/services/dataCache'
import { retryIdempotent } from '@/services/workbookMutations'

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
        const identity = String(partner['UEI Number'] || '').trim()
        const patch = pendingPatches.current.get(identity)
        if (!patch) return partner
        const confirmed = Object.keys(patch).every((key) => partner[key] === patch[key])
        if (confirmed) pendingPatches.current.delete(identity)
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
  useEffect(() => onCacheRefresh((tables) => {
    if (tables?.includes('PartnersTable')) return load({ silent: true })
    return undefined
  }), [load])

  const add = useCallback(async (data) => {
    const saved = await addPartner(data)
    setPartners((current) => {
      if (current.some((partner) => partner['UEI Number'] === saved['UEI Number'])) return current
      return [...current, saved]
    })
    await publishCacheUpdate(['PartnersTable'])
    verifyCacheInBackground(['PartnersTable'])
    return saved
  }, [])

  const update = useCallback(async (rowIndex, patch, original) => {
    const identity = String(original?.['UEI Number'] || '').trim()
    if (identity) pendingPatches.current.set(identity, patch)
    setPartners((current) => current.map((partner) =>
      partner._rowIndex === rowIndex ? { ...partner, ...patch } : partner
    ))
    try {
      await retryIdempotent(() => updatePartner(rowIndex, patch, original))
      await publishCacheUpdate(['PartnersTable'])
      verifyCacheInBackground(['PartnersTable'])
    } catch (err) {
      if (identity) pendingPatches.current.delete(identity)
      setPartners((current) => current.map((partner) =>
        partner._rowIndex === rowIndex ? original : partner
      ))
      throw err
    }
  }, [])

  const remove = useCallback(async (rowIndex, original) => {
    setPartners((current) => current.filter((partner) => partner._rowIndex !== rowIndex))
    try {
      await retryIdempotent(() => deletePartner(rowIndex, original))
      await publishCacheUpdate(['PartnersTable'])
      verifyCacheInBackground(['PartnersTable'])
    } catch (err) {
      setPartners((current) => [...current, original].sort((a, b) => a._rowIndex - b._rowIndex))
      throw err
    }
  }, [])

  const refresh = useCallback(async () => {
    await forceRefreshCache(['PartnersTable']).catch(() => {})
    await load()
  }, [load])

  return { partners, loading, error, refresh, add, update, remove }
}
