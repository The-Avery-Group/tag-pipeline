import { useState, useEffect, useCallback } from 'react'
import { getNotes, addNote } from '@/services/graphService'
import { invalidateCache, onCacheRefresh } from '@/services/dataCache'

async function retryThrice(fn) {
  let lastErr
  for (let i = 0; i < 3; i++) {
    try { return await fn() } catch (err) { lastErr = err }
  }
  throw lastErr
}

export function useNotes(contractNumber) {
  const [notes, setNotes]     = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState(null)

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
  useEffect(() => { return onCacheRefresh(load) }, [load])

  const add = useCallback(async (author, text) => {
    if (!contractNumber) throw new Error('contractNumber required')

    // Optimistic: prepend note immediately with temp id
    const tempNote = {
      NoteID:         `temp-${Date.now()}`,
      ContractNumber: contractNumber,
      Author:         author,
      NoteText:       text,
      Date:           new Date().toISOString().split('T')[0],
      _temp:          true,
    }
    setNotes((prev) => [tempNote, ...prev])

    try {
      // Retry up to 3 times silently
      await retryThrice(() => addNote(contractNumber, author, text))
      await invalidateCache()
      // Cache refresh will replace the temp note with the real one
    } catch (err) {
      // Silent fail: remove temp note, will reappear on next sync
      setNotes((prev) => prev.filter((n) => n.NoteID !== tempNote.NoteID))
      // Re-throw so the caller can show a toast
      throw err
    }
  }, [contractNumber])

  return { notes, loading, error, refresh: load, add }
}
