import { useState, useEffect, useCallback, useRef } from 'react'
import { getNotes, addNote, updateNote, deleteNote } from '@/services/graphService'
import {
  forceRefreshCache,
  onCacheRefresh,
  verifyCacheInBackground,
} from '@/services/dataCache'
import { createStableId, retryIdempotent } from '@/services/workbookMutations'

// Notes are presented as a chronological conversation. The workbook stores a
// date rather than a time, so use its physical row order to keep notes added
// on the same day in their natural creation order.
function compareNotesOldestFirst(a, b) {
  const dateA = new Date(`${a.Date || ''}T00:00:00`).getTime()
  const dateB = new Date(`${b.Date || ''}T00:00:00`).getTime()
  const safeDateA = Number.isNaN(dateA) ? 0 : dateA
  const safeDateB = Number.isNaN(dateB) ? 0 : dateB
  if (safeDateA !== safeDateB) return safeDateA - safeDateB

  const rowA = Number(a._rowIndex)
  const rowB = Number(b._rowIndex)
  const hasRowA = Number.isFinite(rowA)
  const hasRowB = Number.isFinite(rowB)
  if (hasRowA && hasRowB && rowA !== rowB) return rowA - rowB
  if (hasRowA !== hasRowB) return hasRowA ? -1 : 1

  return Number(a._createdAt || 0) - Number(b._createdAt || 0)
}

export function useNotes(contractNumber) {
  const [notes, setNotes]     = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState(null)

  // Rows optimistically removed but not yet confirmed deleted server-side —
  // filtered out of every load() so a racing background poll can't make a
  // just-deleted note flicker back into view before the delete propagates
  // (same class of bug fixed in the other hooks' pendingPatches tracking).
  const pendingDeletes = useRef(new Set())
  const pendingPatches = useRef(new Map())

  const load = useCallback(async ({ silent = false } = {}) => {
    if (!silent) {
      setLoading(true)
      setError(null)
    }
    try {
      const all = await getNotes()
      const filtered = (contractNumber ? all.filter((n) => n.ContractNumber === contractNumber) : all)
        .filter((n) => !pendingDeletes.current.has(n._rowIndex))
        .map((note) => {
          const patch = pendingPatches.current.get(note._rowIndex)
          if (!patch) return note
          const confirmed = Object.keys(patch).every((key) => note[key] === patch[key])
          if (confirmed) pendingPatches.current.delete(note._rowIndex)
          return confirmed ? note : { ...note, ...patch }
        })
      setNotes([...filtered].sort(compareNotesOldestFirst))
    } catch (err) {
      if (!silent) setError(err.message)
    } finally {
      if (!silent) setLoading(false)
    }
  }, [contractNumber])

  useEffect(() => { load() }, [load])
  useEffect(() => onCacheRefresh((tables) => {
    if (tables?.includes('NotesTable')) return load({ silent: true })
    return undefined
  }), [load])

  const add = useCallback(async (author, text) => {
    if (!contractNumber) throw new Error('contractNumber required')
    const noteId = createStableId('N')

    // Optimistic: append note immediately so the composer and note stream
    // retain their oldest-to-newest order.
    const tempNote = {
      NoteID:         noteId,
      ContractNumber: contractNumber,
      Author:         author,
      NoteText:       text,
      Date:           new Date().toISOString().split('T')[0],
      _createdAt:     Date.now(),
      _temp:          true,
    }
    setNotes((prev) => [...prev, tempNote])

    try {
      const saved = await addNote(contractNumber, author, text, noteId)
      setNotes((current) => current.map((note) =>
        note.NoteID === noteId ? saved : note
      ).sort(compareNotesOldestFirst))
      verifyCacheInBackground(['NotesTable'])
      return saved
    } catch (err) {
      setNotes((prev) => prev.filter((n) => n.NoteID !== tempNote.NoteID))
      throw err
    }
  }, [contractNumber])

  const remove = useCallback(async (rowIndex) => {
    pendingDeletes.current.add(rowIndex)
    setNotes((prev) => prev.filter((n) => n._rowIndex !== rowIndex))
    try {
      await retryIdempotent(() => deleteNote(rowIndex))
      verifyCacheInBackground(['NotesTable'])
    } catch (err) {
      // Delete didn't actually happen — stop hiding it so the note
      // reappears (via reload) rather than staying hidden forever
      pendingDeletes.current.delete(rowIndex)
      await load()
      throw err
    }
  }, [load])

  const update = useCallback(async (rowIndex, patch, original) => {
    pendingPatches.current.set(rowIndex, patch)
    setNotes((prev) => prev.map((note) => note._rowIndex === rowIndex ? { ...note, ...patch } : note))
    try {
      await retryIdempotent(() => updateNote(rowIndex, patch))
      verifyCacheInBackground(['NotesTable'])
    } catch (err) {
      pendingPatches.current.delete(rowIndex)
      setNotes((prev) => prev.map((note) => note._rowIndex === rowIndex ? original : note))
      throw err
    }
  }, [])

  const refresh = useCallback(async () => {
    await forceRefreshCache(['NotesTable']).catch(() => {})
    await load()
  }, [load])

  return { notes, loading, error, refresh, add, update, remove }
}
