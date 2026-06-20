import { useState, useEffect, useCallback } from 'react'
import {
  getSAMOpportunities, addSAMOpportunity, updateSAMOpportunity, deleteSAMOpportunity,
  getContacts, addContact, addOpportunity, addContactToPOC,
  CONTACTS_HEADERS,
} from '@/services/graphService'
import { invalidateCache, onCacheRefresh } from '@/services/dataCache'

const WORKER_URL = import.meta.env.VITE_API_BASE_URL

// ── POC parser ────────────────────────────────────────────────────────────
// POC format from SAM: "Name | email | phone"
function parsePOC(pocStr) {
  if (!pocStr) return { name: '', email: '', phone: '' }
  const parts = String(pocStr).split('|').map((s) => s.trim())
  return {
    name:  parts[0] || '',
    email: parts[1] || '',
    phone: parts[2] || '',
  }
}

// ── SAM key expiry check ──────────────────────────────────────────────────
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
  useEffect(() => { return onCacheRefresh(load) }, [load])

  // ── Update status ────────────────────────────────────────────────────
  const updateStatus = useCallback(async (rowIndex, status) => {
    await updateSAMOpportunity(rowIndex, { Status: status })
    await invalidateCache()
  }, [])

  // ── Contact lookup or create ─────────────────────────────────────────
  // Returns the contact Name to use for POC linking.
  // Searches by email first, then by name. Creates if neither matches.
  const resolveContact = useCallback(async (poc, agency, department) => {
    if (!poc.name && !poc.email) return null

    const allContacts = await getContacts()

    // 1. Email match (most reliable)
    if (poc.email) {
      const byEmail = allContacts.find(
        (c) => c.Email && c.Email.trim().toLowerCase() === poc.email.toLowerCase()
      )
      if (byEmail) return byEmail.Name
    }

    // 2. Name match (case-insensitive)
    if (poc.name) {
      const byName = allContacts.find(
        (c) => c.Name && c.Name.trim().toLowerCase() === poc.name.toLowerCase()
      )
      if (byName) return byName.Name
    }

    // 3. Not found — create new contact
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
    await invalidateCache()

    // Return the name we just wrote
    return poc.name || poc.email || 'Unknown'
  }, [])

  // ── Add to pipeline ──────────────────────────────────────────────────
  // outlook: 'New' for Add to Pipeline, 'Tracking' for Track
  const addToPipeline = useCallback(async (row, outlook = 'New') => {
    const poc = parsePOC(row['Point of Contact'])

    // Resolve contact (lookup or create)
    const contactName = await resolveContact(poc, row['Agency'], row['Department'])

    // Build pipeline row — only fields that exist in PIPELINE_HEADERS
    const pipelineData = {
      'TAG Opportunity Phase':              'Identified',
      'Opportunity Outlook':                outlook,
      'Contract Number / Notice ID':        row['Solicitation Number'] || row['Notice ID'] || '',
      'Project Title / Description*':       row['Title']               || '',
      'Solicitation Number':                row['Solicitation Number'] || '',
      'Set- Aside*':                        row['Set-Aside Type']      || '',
      'Department*':                        row['Department']          || '',
      'Agency*':                            row['Agency']              || '',
      'Office*':                            row['Office']              || '',
      'NAICS Code*':                        row['NAICS Code']          || '',
      'Contracting Officer / Specialist (POC)*': contactName           || '',
    }

    await addOpportunity(pipelineData)

    // Link contact to the new opportunity via POC column
    // addOpportunity already writes contactName into the POC column above,
    // but we also ensure the contact side is linked if needed
    // (addOpportunity writes the name string directly — contact card system
    //  picks it up on next render via parsePOCNames)

    // Update NewOpportunities status
    const status = outlook === 'Tracking' ? 'tracked' : 'added_to_pipeline'
    await updateSAMOpportunity(row._rowIndex, { Status: status })
    await invalidateCache()
  }, [resolveContact])

  // ── Dismiss / un-dismiss ─────────────────────────────────────────────
  const dismiss   = useCallback((rowIndex) => updateStatus(rowIndex, 'dismissed'), [updateStatus])
  const undismiss = useCallback((rowIndex) => updateStatus(rowIndex, 'new'),       [updateStatus])

  // ── Delete a row ─────────────────────────────────────────────────────
  const remove = useCallback(async (rowIndex) => {
    await deleteSAMOpportunity(rowIndex)
    await invalidateCache()
  }, [])

  return {
    opportunities,
    loading,
    error,
    refresh: load,
    addToPipeline,
    dismiss,
    undismiss,
    remove,
    updateStatus,
  }
}