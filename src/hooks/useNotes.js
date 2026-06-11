import { useState, useEffect, useCallback } from 'react'
import { getNotes, addNote } from '@/services/graphService'

export function useNotes(contractNumber) {
  const [notes, setNotes] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const all = await getNotes()
      const filtered = contractNumber
        ? all.filter((n) => n.ContractNumber === contractNumber)
        : all
      const sorted = [...filtered].sort((a, b) => new Date(b.Date) - new Date(a.Date))
      setNotes(sorted)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [contractNumber])

  useEffect(() => { load() }, [load])

  const add = useCallback(async (author, text) => {
    if (!contractNumber) throw new Error('contractNumber required')
    await addNote(contractNumber, author, text)
    await load()
  }, [contractNumber, load])

  return { notes, loading, error, refresh: load, add }
}
