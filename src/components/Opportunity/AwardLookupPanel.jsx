import { useState } from 'react'
import AwardRecordCard from '@/components/Awards/AwardRecordCard'
import awardStyles from '@/components/Awards/AwardRecordCard.module.css'

function storedLinkUrl(value) {
  const text = String(value || '').trim()
  const separator = text.lastIndexOf('|')
  return (separator >= 0 ? text.slice(separator + 1) : text).trim()
}

// Kept separate from OpportunityDetail so award lookup state, record
// selection, and field-level updates cannot affect the rest of the page.
export default function AwardLookupPanel({
  opp, contractNumber, updateOpp, toast, awards, columns, dateOnly, cleanLinks, joinLinks,
}) {
  const [open, setOpen] = useState(false)
  const { results, loading, error, searched, cache, lookup } = awards
  const [updatedFields, setUpdatedFields] = useState({})
  const [updatingFields, setUpdatingFields] = useState({})
  const [selectedModification, setSelectedModification] = useState({})

  const handleToggle = () => {
    const next = !open
    setOpen(next)
    if (next && !searched && !loading) lookup({ piid: contractNumber })
  }

  const setUpdating = (piid, fieldKey, value) => {
    setUpdatingFields((previous) => ({ ...previous, [piid]: { ...previous[piid], [fieldKey]: value } }))
  }
  const setUpdated = (piid, fieldKey) => {
    setUpdatedFields((previous) => ({ ...previous, [piid]: { ...previous[piid], [fieldKey]: true } }))
  }

  const handleUpdateField = async (piid, fieldKey, field) => {
    setUpdating(piid, fieldKey, true)
    try {
      const value = field.column === columns.endDate ? dateOnly(field.value) : field.value
      await updateOpp(opp._rowIndex, { [field.column]: value }, opp)
      setUpdated(piid, fieldKey)
      toast?.success(`${field.column.replace(/\*$/, '')} updated`)
    } catch (error) {
      toast?.error(`Failed to update: ${error.message}`)
    } finally {
      setUpdating(piid, fieldKey, false)
    }
  }

  const handleAddAwardNoticeLink = async (piid, fieldKey, field) => {
    const link = String(field.value || '').trim()
    if (!link) return
    const existing = cleanLinks(opp[columns.otherLinks])
    if (existing.some((value) => storedLinkUrl(value).toLowerCase() === link.toLowerCase())) {
      toast?.success('Award notice link is already in other links')
      setUpdated(piid, fieldKey)
      return
    }
    setUpdating(piid, fieldKey, true)
    try {
      await updateOpp(opp._rowIndex, { [columns.otherLinks]: joinLinks([...existing, link]) }, opp)
      setUpdated(piid, fieldKey)
      toast?.success('Award notice link added to other links')
    } catch (error) {
      toast?.error(`Failed to add link: ${error.message}`)
    } finally {
      setUpdating(piid, fieldKey, false)
    }
  }

  return (
    <div className="card" style={{ padding: 0, overflow: 'hidden', marginBottom: 12 }}>
      <button onClick={handleToggle} style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '12px 16px', background: 'var(--surface)', border: 'none', cursor: 'pointer', textAlign: 'left', fontFamily: 'var(--font)' }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--gray-900)', flex: 1 }}>Contract award lookup</span>
        {loading && <span className="text-xs text-muted">Looking up…</span>}
        <span style={{ fontSize: 18, color: 'var(--gray-400)', lineHeight: 1, transform: open ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform 0.2s' }}>›</span>
      </button>
      {open && <div style={{ borderTop: '0.5px solid var(--gray-200)', padding: '12px 16px' }}>
        {loading && <p className="text-sm text-muted">Looking up award data for {contractNumber}…</p>}
        {error && <p className="text-sm" style={{ color: 'var(--red-600)' }}>Lookup failed: {error}</p>}
        {searched && !loading && !error && results.length === 0 && <p className="text-sm text-muted">No award data found for {contractNumber}.</p>}
        {results.map((record) => {
          const piid = record.piid || record.raw?.contractId?.piid
          const modifications = record.modifications || []
          const activeModificationIndex = Math.min(selectedModification[piid] ?? 0, Math.max(modifications.length - 1, 0))
          const activeModification = modifications[activeModificationIndex]
          const fields = activeModification?.snapshotFields
            ? activeModification.snapshotFields
            : activeModification
              ? { ...Object.fromEntries(Object.entries(record.fields || {}).filter(([, field]) => field.section !== 'Latest modification')), ...activeModification }
              : record.fields
          const viewingLatestModification = activeModificationIndex === 0
          return <div key={piid || `award-${activeModificationIndex}`}>
            {modifications.length > 0 && <>
              <div className={awardStyles.modificationTabs} role="tablist" aria-label="Recent modifications">
                {modifications.map((modification, index) => {
                  const number = modification.modificationNumber?.value || (index === modifications.length - 1 ? 'Base award' : 'Modification')
                  return <button key={`${number}-${modification.dateSigned?.value || index}`} type="button" role="tab" aria-selected={activeModificationIndex === index} className={`${awardStyles.modificationTab} ${activeModificationIndex === index ? awardStyles.modificationTabActive : ''}`} onClick={() => setSelectedModification((previous) => ({ ...previous, [piid]: index }))}>{index === 0 ? `Latest · ${number}` : number}</button>
                })}
              </div>
              <p className="text-xs text-muted" style={{ margin: '0 0 8px' }}>Each tab shows data reported by SAM for that modification.</p>
            </>}
            <AwardRecordCard
              piid={piid}
              isIDV={record.isIDV}
              modificationCount={record.modificationCount}
              originalSignedDate={record.originalSignedDate}
              samLink={record.samLink}
              cache={cache}
              onRefresh={() => lookup({ piid: contractNumber, forceRefresh: true })}
              refreshing={loading}
              fields={fields}
              contractLifecycleAlert={viewingLatestModification ? record.contractLifecycleAlert : null}
              renderFieldAction={(fieldKey, field) => {
                const done = Boolean(updatedFields[piid]?.[fieldKey])
                const updating = Boolean(updatingFields[piid]?.[fieldKey])
                if (field.action === 'addOtherLink') return <button className={`${awardStyles.fieldAction} ${done ? awardStyles.fieldActionDone : ''}`} onClick={() => handleAddAwardNoticeLink(piid, fieldKey, field)} disabled={done || updating}>{done ? 'Added' : updating ? 'Adding…' : 'Add to other links'}</button>
                if (!field.column) return null
                return <button className={`${awardStyles.fieldAction} ${done ? awardStyles.fieldActionDone : ''}`} onClick={() => handleUpdateField(piid, fieldKey, field)} disabled={done || updating}>{done ? '✓ Applied' : updating ? 'Applying…' : 'Apply to opportunity'}</button>
              }}
            />
          </div>
        })}
      </div>}
    </div>
  )
}
