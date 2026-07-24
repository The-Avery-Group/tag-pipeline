import { useState, useEffect, useCallback, useRef } from 'react'
import { getContacts, addContact, updateContact, deleteContact } from '@/services/graphService'
import { invalidateCache, onCacheRefresh } from '@/services/dataCache'

export function useContacts() {
  const [contacts, setContacts] = useState([])
  const [loading, setLoading]   = useState(true)
  const [error, setError]       = useState(null)

  // Tracks in-flight field patches not yet confirmed by a server read, so a
  // racing refresh (background poll, or any other hook's invalidateCache())
  // can't clobber an edit before the write has actually landed.
  const pendingPatches = useRef(new Map())

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await getContacts()
      const reconciled = data.map((c) => {
        const patch = pendingPatches.current.get(c._rowIndex)
        if (!patch) return c
        const confirmed = Object.keys(patch).every((k) => c[k] === patch[k])
        if (confirmed) {
          pendingPatches.current.delete(c._rowIndex)
          return c
        }
        return { ...c, ...patch }
      })
      setContacts(reconciled)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  useEffect(() => {
    const unsub = onCacheRefresh((tables) => {
      if (tables?.includes('ContactsTable')) load()
    })
    return unsub
  }, [load])

  const add = useCallback(async (data) => {
    // Optimistic: add a placeholder row immediately so the UI reflects the
    // new contact without waiting for the full round-trip + cache refresh.
    const tempId = `C-temp-${Date.now()}`
    const optimistic = { ...data, ContactID: tempId, _rowIndex: -1 }
    setContacts((prev) => [...prev, optimistic])
    try {
      await addContact(data)
      await invalidateCache(['ContactsTable'])
    } catch (err) {
      // Roll back the optimistic row on failure
      setContacts((prev) => prev.filter((c) => c.ContactID !== tempId))
      throw err
    }
  }, [])

  const update = useCallback(async (rowIndex, patch) => {
    pendingPatches.current.set(rowIndex, patch)
    // Optimistic: apply patch immediately
    setContacts((prev) =>
      prev.map((c) => c._rowIndex === rowIndex ? { ...c, ...patch } : c)
    )
    try {
      await updateContact(rowIndex, patch)
      await invalidateCache(['ContactsTable'])
    } catch (err) {
      // Roll back by reloading from server
      pendingPatches.current.delete(rowIndex)
      await load()
      throw err
    }
  }, [load])

  const remove = useCallback(async (rowIndex) => {
    // Optimistic: remove immediately
    setContacts((prev) => prev.filter((c) => c._rowIndex !== rowIndex))
    try {
      await deleteContact(rowIndex)
      await invalidateCache(['ContactsTable'])
    } catch (err) {
      await load()
      throw err
    }
  }, [load])

  return { contacts, loading, error, refresh: load, add, update, remove }
}
