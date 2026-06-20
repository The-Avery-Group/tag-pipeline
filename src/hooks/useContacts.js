import { useState, useEffect, useCallback } from 'react'
import { getContacts, addContact, updateContact, deleteContact } from '@/services/graphService'
import { invalidateCache, onCacheRefresh } from '@/services/dataCache'

export function useContacts() {
  const [contacts, setContacts] = useState([])
  const [loading, setLoading]   = useState(true)
  const [error, setError]       = useState(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await getContacts()
      setContacts(data)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  useEffect(() => {
    const unsub = onCacheRefresh(load)
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
      await invalidateCache()   // reconciles with the real server-assigned ID
    } catch (err) {
      // Roll back the optimistic row on failure
      setContacts((prev) => prev.filter((c) => c.ContactID !== tempId))
      throw err
    }
  }, [])

  const update = useCallback(async (rowIndex, patch) => {
    // Optimistic: apply patch immediately
    setContacts((prev) =>
      prev.map((c) => c._rowIndex === rowIndex ? { ...c, ...patch } : c)
    )
    try {
      await updateContact(rowIndex, patch)
      await invalidateCache()
    } catch (err) {
      // Roll back by reloading from server
      await load()
      throw err
    }
  }, [load])

  const remove = useCallback(async (rowIndex) => {
    // Optimistic: remove immediately
    setContacts((prev) => prev.filter((c) => c._rowIndex !== rowIndex))
    try {
      await deleteContact(rowIndex)
      await invalidateCache()
    } catch (err) {
      await load()
      throw err
    }
  }, [load])

  return { contacts, loading, error, refresh: load, add, update, remove }
}
