import { useState, useEffect, useCallback } from 'react'
import { getNotes, addNote } from '@/services/graphService'
import { invalidateCache, onCacheRefresh } from '@/services/dataCache'

export function useNotes(contractNumber) {
  const [notes, setNotes]   = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError]   = useState(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const all = await getNotes()
      const filtered = contractNumber
        ? all.filter((n) => n.ContractNumber === contractNumber)
        : all
      setNotes([...filtered].sort((a, b) => new Date(b.Date) - new Date(a.Date)))
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [contractNumber])

  useEffect(() => { load() }, [load])

  useEffect(() => {
    const unsub = onCacheRefresh(load)
    return unsub
  }, [load])

  const add = useCallback(async (author, text) => {
    if (!contractNumber) throw new Error('contractNumber required')
    await addNote(contractNumber, author, text)
    await invalidateCache()
  }, [contractNumber])

  return { notes, loading, error, refresh: load, add }
}