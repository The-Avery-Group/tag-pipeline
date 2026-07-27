import { useState, useEffect, useCallback, useRef } from 'react'
import { getContacts, addContact, updateContact, deleteContact } from '@/services/graphService'
import { forceRefreshCache, invalidateCache, onCacheRefresh } from '@/services/dataCache'

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
      // Optimistic: add a placeholder row immediately so the UI reflects the
      // new contact without waiting for the full round-trip + cache refresh.
      const tempId = `C-temp-${Date.now()}`
      const optimistic = { ...data, ContactID: tempId, _rowIndex: -1 }
      setContacts((prev) => [...prev, optimistic])
      try {
        const saved = await addContact(data)
        setContacts((prev) =>
          prev.map((contact) => contact.ContactID === tempId ? { ...saved, _rowIndex: -1 } : contact)
        )
        await invalidateCache(['ContactsTable'])
        return { contact: saved, added: true, existed: false }
      } catch (err) {
        // A request can fail after Excel accepted the append. Reconcile once
        // before reporting failure so the UI never invites a duplicate retry.
        await invalidateCache(['ContactsTable'])
        const latest = await getContacts().catch(() => [])
        const recovered = latest.find(matches)
        if (recovered) {
          setContacts(latest)
          return { contact: recovered, added: true, existed: false, recovered: true }
        }
        setContacts((prev) => prev.filter((contact) => contact.ContactID !== tempId))
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

  const refresh = useCallback(async () => {
    await forceRefreshCache(['ContactsTable']).catch(() => {})
    await load()
  }, [load])

  return { contacts, loading, error, refresh, add, update, remove }
}
