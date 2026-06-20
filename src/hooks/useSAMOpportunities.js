import { useState, useEffect, useCallback } from 'react'
import {
  getSAMOpportunities, updateSAMOpportunity,
  getContacts, addContact, addOpportunity,
} from '@/services/graphService'
import { invalidateCache, onCacheRefresh } from '@/services/dataCache'

const WORKER_URL = import.meta.env.VITE_API_BASE_URL

// ── POC parser ────────────────────────────────────────────────────────────
function parsePOC(pocStr) {
  if (!pocStr) return { name: '', email: '', phone: '' }
  const parts = String(pocStr).split('|').map((s) => s.trim())
  return { name: parts[0] || '', email: parts[1] || '', phone: parts[2] || '' }
}

// ── Worker status checks ──────────────────────────────────────────────────
export async function checkSAMKeyExpired() {
  if (!WORKER_URL) return false
  try {
    const res = await fetch(`${WORKER_URL}/sam/key-status`)
    if (!res.ok) return false
    const data = await res.json()
    return data.expired === true
  } catch {
    return false
  }
}

export async function getSAMRunStatus() {
  if (!WORKER_URL) return null
  try {
    const res = await fetch(`${WORKER_URL}/sam/run-status`)
    if (!res.ok) return null
    return res.json()
  } catch {
    return null
  }
}

// ── Hook ──────────────────────────────────────────────────────────────────
export function useSAMOpportunities() {
  const [opportunities, setOpportunities] = useState([])
  const [loading, setLoading]             = useState(true)
  const [error, setError]                 = useState(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const rows = await getSAMOpportunities()
      setOpportunities(rows)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])
  useEffect(() => onCacheRefresh(load), [load])

  // ── Contact lookup or create ─────────────────────────────────────────
  const resolveContact = useCallback(async (poc, agency, department) => {
    if (!poc.name && !poc.email) return null
    const allContacts = await getContacts()

    // 1. Email match
    if (poc.email) {
      const byEmail = allContacts.find(
        (c) => c.Email && c.Email.trim().toLowerCase() === poc.email.toLowerCase()
      )
      if (byEmail) return byEmail.Name
    }

    // 2. Name match
    if (poc.name) {
      const byName = allContacts.find(
        (c) => c.Name && c.Name.trim().toLowerCase() === poc.name.toLowerCase()
      )
      if (byName) return byName.Name
    }

    // 3. Create new
    await addContact({
      Name:         poc.name  || poc.email || 'Unknown',
      Email:        poc.email || '',
      Phone:        poc.phone || '',
      Agency:       agency     || '',
      Organization: department || '',
      Type:         'Government',
      Title:        '',
      Notes:        '',
    })
    return poc.name || poc.email || 'Unknown'
  }, [])

  // ── Optimistic status update ─────────────────────────────────────────
  const updateStatus = useCallback(async (rowIndex, status) => {
    // Optimistic — update local state immediately
    setOpportunities((prev) =>
      prev.map((o) => o._rowIndex === rowIndex ? { ...o, Status: status } : o)
    )
    try {
      await updateSAMOpportunity(rowIndex, { Status: status })
      await invalidateCache()
    } catch (err) {
      // Roll back
      await load()
      throw err
    }
  }, [load])

  // ── Add to pipeline ──────────────────────────────────────────────────
  const addToPipeline = useCallback(async (row, outlook = 'New') => {
    const poc = parsePOC(row['Point of Contact'])
    const contactName = await resolveContact(poc, row['Agency'], row['Department'])

    const pipelineData = {
      'TAG Opportunity Phase':                   'Identified',
      'Opportunity Outlook':                     outlook,
      'Contract Number / Notice ID':             row['Solicitation Number'] || row['Notice ID'] || '',
      'Project Title / Description*':            row['Title']               || '',
      'Solicitation Number':                     row['Solicitation Number'] || '',
      'Set- Aside*':                             row['Set-Aside Type']      || '',
      'Department*':                             row['Department']          || '',
      'Agency*':                                 row['Agency']              || '',
      'Office*':                                 row['Office']              || '',
      'NAICS Code*':                             row['NAICS Code']          || '',
      'Contracting Officer / Specialist (POC)*': contactName                || '',
    }

    await addOpportunity(pipelineData)

    const status = outlook === 'Tracking' ? 'tracked' : 'added_to_pipeline'
    await updateStatus(row._rowIndex, status)
  }, [resolveContact, updateStatus])

  const dismiss   = useCallback((rowIndex) => updateStatus(rowIndex, 'dismissed'), [updateStatus])
  const undismiss = useCallback((rowIndex) => updateStatus(rowIndex, 'new'),       [updateStatus])

  return {
    opportunities,
    loading,
    error,
    refresh: load,
    addToPipeline,
    dismiss,
    undismiss,
    updateStatus,
  }
}
