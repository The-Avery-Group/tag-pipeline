import { useState, useEffect, useCallback, useRef } from 'react'
import { getNotes, addNote, updateNote, deleteNote } from '@/services/graphService'
import {
  forceRefreshCache,
  onCacheRefresh,
  publishCacheUpdate,
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

function normalizeRelationship(value) {
  if (typeof value === 'string') {
    const id = value.trim()
    return { type: id ? 'Opportunity' : '', id, contractNumber: id }
  }
  const type = String(value?.type || '').trim()
  const id = String(value?.id || '').trim()
  return {
    type,
    id,
    contractNumber: String(value?.contractNumber || (type === 'Opportunity' ? id : '')).trim(),
  }
}

function noteMatchesRelationship(note, relationship) {
  if (!relationship.type && !relationship.id && !relationship.contractNumber) return true
  const noteType = String(note?.['Related Type'] || '').trim().toLowerCase()
  const noteId = String(note?.['Related ID'] || '').trim().toLowerCase()
  const targetType = relationship.type.toLowerCase()
  const targetId = relationship.id.toLowerCase()
  if (targetType && targetId && noteType === targetType && noteId === targetId) return true
  // Rows created before the relationship columns existed remain available to
  // their opportunity through the original ContractNumber field.
  return targetType === 'opportunity' && relationship.contractNumber &&
    String(note?.ContractNumber || '').trim().toLowerCase() === relationship.contractNumber.toLowerCase()
}

export function useNotes(relationshipValue) {
  const relationship = normalizeRelationship(relationshipValue)
  const relationshipKey = `${relationship.type}:${relationship.id}:${relationship.contractNumber}`
  const [notes, setNotes]     = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState(null)

  // Rows optimistically removed but not yet confirmed deleted server-side —
  // filtered out of every load() so a racing background poll can't make a
  // just-deleted note flicker back into view before the delete propagates
  // (same class of bug fixed in the other hooks' pendingPatches tracking).
  const pendingDeletes = useRef(new Set())
  const pendingPatches = useRef(new Map())
  const notesRef = useRef([])

  useEffect(() => { notesRef.current = notes }, [notes])

  const load = useCallback(async ({ silent = false } = {}) => {
    if (!silent) {
      setLoading(true)
      setError(null)
    }
    try {
      const all = await getNotes()
      const filtered = all.filter((note) => noteMatchesRelationship(note, relationship))
        .filter((n) => !pendingDeletes.current.has(String(n.NoteID || '').trim()))
        .map((note) => {
          const identity = String(note.NoteID || '').trim()
          const patch = pendingPatches.current.get(identity)
          if (!patch) return note
          const confirmed = Object.keys(patch).every((key) => note[key] === patch[key])
          if (confirmed) pendingPatches.current.delete(identity)
          return confirmed ? note : { ...note, ...patch }
        })
      setNotes([...filtered].sort(compareNotesOldestFirst))
    } catch (err) {
      if (!silent) setError(err.message)
    } finally {
      if (!silent) setLoading(false)
    }
  }, [relationshipKey, relationship.type, relationship.id, relationship.contractNumber])

  useEffect(() => {
    setNotes([])
    pendingDeletes.current.clear()
    pendingPatches.current.clear()
    load()
  }, [load])
  useEffect(() => onCacheRefresh((tables) => {
    if (tables?.includes('NotesTable')) return load({ silent: true })
    return undefined
  }), [load])

  const add = useCallback(async (author, text) => {
    if (!relationship.id) throw new Error('A related record is required')
    const noteId = createStableId('N')

    // Optimistic: append note immediately so the composer and note stream
    // retain their oldest-to-newest order.
    const tempNote = {
      NoteID:         noteId,
      ContractNumber: relationship.contractNumber,
      'Related Type': relationship.type,
      'Related ID': relationship.id,
      Author:         author,
      NoteText:       text,
      Date:           new Date().toISOString().split('T')[0],
      _createdAt:     Date.now(),
      _temp:          true,
    }
    setNotes((prev) => [...prev, tempNote])

    try {
      const saved = await addNote(relationship.contractNumber, author, text, noteId, {
        relatedType: relationship.type,
        relatedId: relationship.id,
      })
      setNotes((current) => current.map((note) =>
        note.NoteID === noteId ? saved : note
      ).sort(compareNotesOldestFirst))
      await publishCacheUpdate(['NotesTable'])
      verifyCacheInBackground(['NotesTable'])
      return saved
    } catch (err) {
      setNotes((prev) => prev.filter((n) => n.NoteID !== tempNote.NoteID))
      throw err
    }
  }, [relationshipKey, relationship.type, relationship.id, relationship.contractNumber])

  const remove = useCallback(async (rowIndex) => {
    const original = notesRef.current.find((note) => note._rowIndex === rowIndex)
    const identity = String(original?.NoteID || '').trim()
    if (identity) pendingDeletes.current.add(identity)
    setNotes((prev) => prev.filter((n) => n._rowIndex !== rowIndex))
    try {
      await retryIdempotent(() => deleteNote(rowIndex, original))
      await publishCacheUpdate(['NotesTable'])
      verifyCacheInBackground(['NotesTable'])
      if (identity) pendingDeletes.current.delete(identity)
    } catch (err) {
      // Delete didn't actually happen — stop hiding it so the note
      // reappears (via reload) rather than staying hidden forever
      if (identity) pendingDeletes.current.delete(identity)
      await load()
      throw err
    }
  }, [load])

  const update = useCallback(async (rowIndex, patch, original) => {
    const identity = String(original?.NoteID || '').trim()
    if (identity) pendingPatches.current.set(identity, patch)
    setNotes((prev) => prev.map((note) => note._rowIndex === rowIndex ? { ...note, ...patch } : note))
    try {
      await retryIdempotent(() => updateNote(rowIndex, patch, original))
      await publishCacheUpdate(['NotesTable'])
      verifyCacheInBackground(['NotesTable'])
    } catch (err) {
      if (identity) pendingPatches.current.delete(identity)
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
