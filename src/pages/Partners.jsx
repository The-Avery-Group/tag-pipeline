import { useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import Topbar from '@/components/Layout/Topbar'
import Modal from '@/components/Common/Modal'
import { usePartners } from '@/hooks/usePartners'
import { useAsyncAction } from '@/hooks/useAsyncAction'
import { recordMatches } from '@/utils/searchHelpers'
import styles from './Partners.module.css'

const FIELDS = [
  ['Partner Name', 'Partner name', 'input'],
  ['UEI Number', 'UEI number', 'input', true],
  ['Contact Information', 'Contact information', 'textarea'],
  ['NAICS Codes', 'NAICS codes', 'input'],
  ['Company Strengths', 'Company strengths', 'textarea'],
  ['Capabilities', 'Capabilities', 'textarea'],
  ['Agencies Worked with', 'Agencies worked with', 'textarea'],
  ['Contracts Vehicles', 'Contract vehicles', 'textarea'],
  ['Keywords', 'Keywords', 'input'],
  ['Link to website', 'Website link', 'input'],
  ['Link to onedrive folder', 'OneDrive folder link', 'input'],
  ['Notes', 'Notes', 'textarea'],
]

const EMPTY_PARTNER = () => Object.fromEntries(FIELDS.map(([key]) => [key, '']))

function safeUrl(value) {
  const url = String(value || '').trim()
  if (!url) return ''
  return /^https?:\/\//i.test(url) ? url : `https://${url}`
}

export default function Partners({ toast }) {
  const { partners, loading, error, refresh, add, update, remove } = usePartners()
  const [searchParams, setSearchParams] = useSearchParams()
  const [search, setSearch] = useState(() => searchParams.get('search') || '')
  const [form, setForm] = useState(EMPTY_PARTNER)
  const [editingPartner, setEditingPartner] = useState(null)
  const [showForm, setShowForm] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState(null)
  const saveAction = useAsyncAction()
  const deleteAction = useAsyncAction()

  const filtered = useMemo(() => partners.filter((partner) => recordMatches(partner, search)), [partners, search])

  const openAdd = () => {
    setForm(EMPTY_PARTNER())
    setEditingPartner(null)
    setShowForm(true)
  }

  const openEdit = (partner) => {
    setForm({ ...EMPTY_PARTNER(), ...partner })
    setEditingPartner(partner)
    setShowForm(true)
  }

  const submit = async () => {
    const uei = String(form['UEI Number'] || '').trim().toUpperCase()
    if (!uei) {
      toast?.error('UEI number is required')
      return
    }
    const duplicate = partners.find((partner) =>
      partner._rowIndex !== editingPartner?._rowIndex && String(partner['UEI Number'] || '').trim().toUpperCase() === uei
    )
    if (duplicate) {
      toast?.error('A partner with that UEI already exists')
      return
    }
    const next = { ...form, 'Partner Name': String(form['Partner Name'] || '').trim(), 'UEI Number': uei }
    try {
      await saveAction.run(
        () => editingPartner
          ? update(editingPartner._rowIndex, next, editingPartner)
          : add(next),
        { onError: (err) => toast?.error(`Failed: ${err.message}`) }
      )
      toast?.success(editingPartner ? 'Partner updated' : 'Partner added')
      setShowForm(false)
      setEditingPartner(null)
    } catch {
      // The action's error handler has already shown the failure.
    }
  }

  const confirmDelete = async () => {
    try {
      await deleteAction.run(() => remove(deleteTarget._rowIndex, deleteTarget), {
        onError: (err) => toast?.error(`Failed: ${err.message}`),
      })
      toast?.success('Partner deleted')
      setDeleteTarget(null)
    } catch {
      // The action's error handler has already shown the failure.
    }
  }

  return (
    <>
      <Topbar
        title="Partners"
        subtitle1={`${partners.length} partners`}
        showFilter={false}
        showNew
        newLabel="New partner"
        onNew={openAdd}
      />
      <div className="page-body">
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <div className={styles.searchBar}>
            <input
              className={styles.searchInput}
              placeholder="Search all partner fields…"
              value={search}
              onChange={(event) => {
                const value = event.target.value
                setSearch(value)
                setSearchParams((current) => {
                  const next = new URLSearchParams(current)
                  if (value) next.set('search', value)
                  else next.delete('search')
                  return next
                }, { replace: true })
              }}
            />
            <span className="text-xs text-muted">{filtered.length} partners</span>
          </div>

          {loading
            ? <div style={{ padding: 20 }}><div className="skeleton" style={{ height: 180 }} /></div>
            : error
              ? <div className={styles.emptyState}><p>Could not load partners: {error}</p><button className="btn" onClick={refresh}>Retry</button></div>
              : filtered.length === 0
                ? <div className={styles.emptyState}>{search ? 'No partners match your search.' : 'No partners yet. Add your first partner.'}</div>
                : <div className={styles.list}>
                    {filtered.map((partner) => {
                      const website = safeUrl(partner['Link to website'])
                      const folder = safeUrl(partner['Link to onedrive folder'])
                      return (
                        <article key={partner._rowIndex} className={styles.partnerCard}>
                          <div className={styles.partnerMain}>
                            <div className={styles.partnerName}>{partner['Partner Name'] || partner['UEI Number']}</div>
                            <div className={styles.partnerMeta}>
                              {partner['UEI Number'] && <span>UEI: {partner['UEI Number']}</span>}
                              {partner['NAICS Codes'] && <span>NAICS: {partner['NAICS Codes']}</span>}
                            </div>
                            {partner.Capabilities && <p className={styles.partnerDescription}>{partner.Capabilities}</p>}
                            {partner['Company Strengths'] && <p className={styles.partnerStrengths}><strong>Strengths:</strong> {partner['Company Strengths']}</p>}
                            <div className={styles.partnerTags}>
                              {partner['Agencies Worked with'] && <span>Agencies: {partner['Agencies Worked with']}</span>}
                              {partner['Contracts Vehicles'] && <span>Vehicles: {partner['Contracts Vehicles']}</span>}
                            </div>
                          </div>
                          <div className={styles.partnerActions}>
                            {website && <a className="btn btn-ghost text-sm" href={website} target="_blank" rel="noreferrer">Website</a>}
                            {folder && <a className="btn btn-ghost text-sm" href={folder} target="_blank" rel="noreferrer">Folder</a>}
                            <button className="btn text-sm" onClick={() => openEdit(partner)}>Edit</button>
                            <button className="btn btn-ghost text-sm" style={{ color: 'var(--red-600)' }} onClick={() => setDeleteTarget(partner)}>Delete</button>
                          </div>
                        </article>
                      )
                    })}
                  </div>
          }
        </div>
      </div>

      {showForm && (
        <Modal
          title={editingPartner ? 'Edit partner' : 'New partner'}
          onClose={() => !saveAction.isLoading && setShowForm(false)}
          footer={<>
            <button className="btn" disabled={saveAction.isLoading} onClick={() => setShowForm(false)}>Cancel</button>
            <button className="btn btn-primary" disabled={saveAction.isLoading} onClick={submit}>{saveAction.isLoading ? 'Saving…' : editingPartner ? 'Save changes' : 'Add partner'}</button>
          </>}
        >
          <div className={styles.formGrid}>
            {FIELDS.map(([key, label, type, required]) => (
              <div key={key} className={`form-field ${type === 'textarea' ? styles.fullWidth : ''}`}>
                <label className="form-label">{label}{required ? ' *' : ''}</label>
                {type === 'textarea'
                  ? <textarea className="form-input" rows={3} value={form[key] || ''} onChange={(event) => setForm((current) => ({ ...current, [key]: event.target.value }))} />
                  : <input className="form-input" value={form[key] || ''} onChange={(event) => setForm((current) => ({ ...current, [key]: event.target.value }))} />}
              </div>
            ))}
          </div>
        </Modal>
      )}

      {deleteTarget && (
        <Modal
          title="Delete partner"
          onClose={() => !deleteAction.isLoading && setDeleteTarget(null)}
          footer={<>
            <button className="btn" disabled={deleteAction.isLoading} onClick={() => setDeleteTarget(null)}>Cancel</button>
            <button className="btn btn-danger" disabled={deleteAction.isLoading} onClick={confirmDelete}>{deleteAction.isLoading ? 'Deleting…' : 'Delete'}</button>
          </>}
        >
          <p className="text-sm">Delete <strong>{deleteTarget['Partner Name']}</strong>? This cannot be undone.</p>
        </Modal>
      )}
    </>
  )
}
