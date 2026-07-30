import { useState, useEffect, useCallback, useRef } from 'react'
import { getContacts, addContact, updateContact, deleteContact } from '@/services/graphService'
import {
  forceRefreshCache,
  onCacheRefresh,
  publishCacheUpdate,
  verifyCacheInBackground,
} from '@/services/dataCache'
import { createStableId, retryIdempotent } from '@/services/workbookMutations'

export function useContacts() {
  const [contacts, setContacts] = useState([])
  const [loading, setLoading]   = useState(true)
  const [error, setError]       = useState(null)

  // Tracks in-flight field patches not yet confirmed by a server read, so a
  // racing refresh (background poll, or any other hook's invalidateCache())
  // can't clobber an edit before the write has actually landed.
  const pendingPatches = useRef(new Map())
  const pendingAdds = useRef(new Map())
  const contactsRef = useRef([])

  useEffect(() => {
    contactsRef.current = contacts
  }, [contacts])

  const load = useCallback(async ({ silent = false } = {}) => {
    if (!silent) {
      setLoading(true)
      setError(null)
    }
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
      if (!silent) setError(err.message)
    } finally {
      if (!silent) setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  useEffect(() => {
    const unsub = onCacheRefresh((tables) => {
      if (tables?.includes('ContactsTable')) return load({ silent: true })
      return undefined
    })
    return unsub
  }, [load])

  const add = useCallback(async (data) => {
    const normalized = (value) => String(value || '').trim().toLowerCase().replace(/\s+/g, ' ')
    const email = normalized(data?.Email)
    const name = normalized(data?.Name)
    const organization = normalized(data?.Agency || data?.Organization)
    const fingerprint = email
      ? `email:${email}`
      : `name:${name}|organization:${organization}`
    const matches = (contact) => {
      const contactEmail = normalized(contact?.Email)
      if (email && contactEmail) return email === contactEmail
      return Boolean(name) &&
        name === normalized(contact?.Name) &&
        organization === normalized(contact?.Agency || contact?.Organization)
    }

    const existing = contactsRef.current.find(matches)
    if (existing) return { contact: existing, added: false, existed: true }
    if (pendingAdds.current.has(fingerprint)) return pendingAdds.current.get(fingerprint)

    const operation = (async () => {
      const contactId = createStableId('C')
      const optimistic = { ...data, ContactID: contactId, _rowIndex: -1, _temp: true }
      setContacts((prev) => [...prev, optimistic])
      try {
        const saved = await addContact(data, contactId)
        setContacts((prev) =>
          prev.map((contact) => contact.ContactID === contactId ? saved : contact)
        )
        await publishCacheUpdate(['ContactsTable'])
        verifyCacheInBackground(['ContactsTable'])
        return {
          contact: saved,
          added: !saved._alreadyExisted,
          existed: Boolean(saved._alreadyExisted),
          recovered: Boolean(saved._reconciled),
        }
      } catch (err) {
        setContacts((prev) => prev.filter((contact) => contact.ContactID !== contactId))
        throw err
      }
    })()

    pendingAdds.current.set(fingerprint, operation)
    try {
      return await operation
    } finally {
      pendingAdds.current.delete(fingerprint)
    }
  }, [])

  const update = useCallback(async (rowIndex, patch) => {
    pendingPatches.current.set(rowIndex, patch)
    // Optimistic: apply patch immediately
    setContacts((prev) =>
      prev.map((c) => c._rowIndex === rowIndex ? { ...c, ...patch } : c)
    )
    try {
      await retryIdempotent(() => updateContact(rowIndex, patch))
      await publishCacheUpdate(['ContactsTable'])
      verifyCacheInBackground(['ContactsTable'])
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
      await retryIdempotent(() => deleteContact(rowIndex))
      await publishCacheUpdate(['ContactsTable'])
      verifyCacheInBackground(['ContactsTable'])
    } catch (err) {
      await load()
      throw err
    }
  }, [load])

  const refresh = useCallback(async () => {
    await forceRefreshCache(['ContactsTable']).catch(() => {})
    await load()
  }, [load])

  return { contacts, loading, error, refresh, add, update, remove }
}
