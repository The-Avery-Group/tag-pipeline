import { useState, useEffect, useCallback } from 'react'
import { getContacts, addContact, updateContact, deleteContact } from '@/services/graphService'

export function useContacts() {
  const [contacts, setContacts] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

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

  const add = useCallback(async (data) => {
    await addContact(data)
    await load()
  }, [load])

  const update = useCallback(async (rowIndex, patch) => {
    await updateContact(rowIndex, patch)
    await load()
  }, [load])

  const remove = useCallback(async (rowIndex) => {
    await deleteContact(rowIndex)
    await load()
  }, [load])

  return { contacts, loading, error, refresh: load, add, update, remove }
}
