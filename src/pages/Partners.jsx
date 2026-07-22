import { useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import Topbar from '@/components/Layout/Topbar'
import Modal from '@/components/Common/Modal'
import { usePartners } from '@/hooks/usePartners'
import { useAsyncAction } from '@/hooks/useAsyncAction'
import { recordMatches } from '@/utils/searchHelpers'
import styles from './Partners.module.css'

const FIELDS = [
  ['Partner Name', 'Partner name', 'input', true, 'identity'],
  ['UEI Number', 'UEI number', 'input', true, 'identity'],
  ['Contact Information', 'Contact information', 'textarea', false, 'contact'],
  ['Link to website', 'Website link', 'input', false, 'contact'],
  ['Link to onedrive folder', 'OneDrive folder link', 'input', false, 'contact'],
  ['NAICS Codes', 'NAICS codes', 'input', false, 'market'],
  ['Agencies Worked with', 'Agencies worked with', 'textarea', false, 'market'],
  ['Contracts Vehicles', 'Contract vehicles', 'textarea', false, 'market'],
  ['Keywords', 'Keywords', 'input', false, 'market'],
  ['Company Strengths', 'Company strengths', 'textarea', false, 'capability'],
  ['Capabilities', 'Capabilities', 'textarea', false, 'capability'],
  ['Notes', 'Notes', 'textarea', false, 'notes'],
]
const EMPTY = () => Object.fromEntries(FIELDS.map(([key]) => [key, '']))
const SECTIONS = [['identity', 'Identity'], ['contact', 'Contact and links'], ['market', 'Market profile'], ['capability', 'Capabilities and strengths'], ['notes', 'Notes']]

function safeUrl(value) {
  const url = String(value || '').trim()
  return !url ? '' : /^https?:\/\//i.test(url) ? url : `https://${url}`
}

function partnerName(partner) {
  return String(partner?.['Partner Name'] || '').trim() || 'Partner name unavailable'
}

function DetailField({ label, value, link }) {
  if (!value) return null
  return <div className={styles.detailField}><span>{label}</span>{link ? <a href={safeUrl(value)} target="_blank" rel="noreferrer">{link}</a> : <div>{value}</div>}</div>
}

export default function Partners({ toast }) {
  const { partners, loading, error, refresh, add, update, remove } = usePartners()
  const [searchParams, setSearchParams] = useSearchParams()
  const [search, setSearch] = useState(() => searchParams.get('search') || '')
  const [selected, setSelected] = useState(null)
  const [form, setForm] = useState(EMPTY)
  const [editing, setEditing] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState(null)
  const saveAction = useAsyncAction()
  const deleteAction = useAsyncAction()

  const filtered = useMemo(() => partners.filter((partner) => recordMatches(partner, search)), [partners, search])
  const select = (partner) => { setSelected(partner); setEditing(false) }
  const startAdd = () => { setSelected(null); setForm(EMPTY()); setEditing(true) }
  const startEdit = () => { setForm({ ...EMPTY(), ...selected }); setEditing(true) }
  const setSearchValue = (value) => {
    setSearch(value)
    setSearchParams((current) => {
      const next = new URLSearchParams(current)
      if (value) next.set('search', value); else next.delete('search')
      return next
    }, { replace: true })
  }

  const save = async () => {
    const name = String(form['Partner Name'] || '').trim()
    const uei = String(form['UEI Number'] || '').trim().toUpperCase()
    if (!name || !uei) { toast?.error('Partner name and UEI number are required'); return }
    if (partners.some((partner) => partner._rowIndex !== selected?._rowIndex && String(partner['UEI Number'] || '').trim().toUpperCase() === uei)) {
      toast?.error('A partner with that UEI already exists'); return
    }
    const next = { ...form, 'Partner Name': name, 'UEI Number': uei }
    try {
      await saveAction.run(() => selected ? update(selected._rowIndex, next, selected) : add(next), { onError: (err) => toast?.error(`Failed: ${err.message}`) })
      setSelected((current) => current ? { ...current, ...next } : null)
      setEditing(false)
      toast?.success(selected ? 'Partner updated' : 'Partner added')
    } catch {}
  }
  const deletePartner = async () => {
    try {
      await deleteAction.run(() => remove(deleteTarget._rowIndex, deleteTarget), { onError: (err) => toast?.error(`Failed: ${err.message}`) })
      if (selected?._rowIndex === deleteTarget._rowIndex) setSelected(null)
      setDeleteTarget(null); toast?.success('Partner deleted')
    } catch {}
  }

  const formSection = (id) => (
    <div className={styles.formSection} key={id}>
      <div className={styles.formSectionTitle}>{SECTIONS.find(([section]) => section === id)?.[1]}</div>
      <div className={styles.formGrid}>{FIELDS.filter(([, , , , section]) => section === id).map(([key, label, type, required]) => <div className={`form-field ${type === 'textarea' ? styles.full : ''}`} key={key}>
        <label className="form-label">{label}{required ? ' *' : ''}</label>
        {type === 'textarea' ? <textarea className="form-input" rows={3} value={form[key] || ''} onChange={(event) => setForm((current) => ({ ...current, [key]: event.target.value }))} /> : <input className="form-input" value={form[key] || ''} onChange={(event) => setForm((current) => ({ ...current, [key]: event.target.value }))} />}
      </div>)}</div>
    </div>
  )

  return <>
    <Topbar title="Partners" subtitle1={`${partners.length} partners`} showFilter={false} showNew newLabel="New partner" onNew={startAdd} />
    <div className={`page-body ${styles.page}`}>
      <div className={`card ${styles.workspace}`}>
        <aside className={styles.listPanel}>
          <div className={styles.searchBar}><input className={styles.searchInput} placeholder="Search partners…" value={search} onChange={(event) => setSearchValue(event.target.value)} /><span>{filtered.length}</span></div>
          {loading ? <div className={styles.listMessage}>Loading partners…</div> : error ? <div className={styles.listMessage}>Could not load partners.<button className="btn btn-ghost text-sm" onClick={refresh}>Retry</button></div> : filtered.length === 0 ? <div className={styles.listMessage}>{search ? 'No matches.' : 'No partners yet.'}</div> : <div className={styles.partnerList}>{filtered.map((partner) => <button key={partner._rowIndex} className={`${styles.listItem} ${selected?._rowIndex === partner._rowIndex ? styles.listItemActive : ''}`} onClick={() => select(partner)}><strong>{partnerName(partner)}</strong><span>UEI: {partner['UEI Number']}</span>{partner.Capabilities && <small>{partner.Capabilities}</small>}</button>)}</div>}
        </aside>
        <section className={styles.profilePanel}>
          {editing ? <div className={styles.editProfile}>
            <div className={styles.profileHeader}><div><h2>{selected ? 'Edit partner' : 'New partner'}</h2><p>UEI is the unique identifier used for incumbent matching.</p></div></div>
            {SECTIONS.map(([id]) => formSection(id))}
            <div className={styles.profileActions}><button className="btn" disabled={saveAction.isLoading} onClick={() => { setEditing(false); if (!selected) setForm(EMPTY()) }}>Cancel</button><button className="btn btn-primary" disabled={saveAction.isLoading} onClick={save}>{saveAction.isLoading ? 'Saving…' : selected ? 'Save changes' : 'Add partner'}</button></div>
          </div> : selected ? <div className={styles.profile}>
            <div className={styles.profileHeader}><div><div className={styles.eyebrow}>Partner profile</div><h2>{partnerName(selected)}</h2><p>UEI: {selected['UEI Number']}</p></div><div className={styles.headerActions}><button className="btn text-sm" onClick={startEdit}>Edit</button><button className="btn btn-ghost text-sm" style={{ color: 'var(--red-600)' }} onClick={() => setDeleteTarget(selected)}>Delete</button></div></div>
            <div className={styles.profileSection}><h3>Contact and links</h3><DetailField label="Contact information" value={selected['Contact Information']} /><DetailField label="Website" value={selected['Link to website']} link="Open website" /><DetailField label="OneDrive folder" value={selected['Link to onedrive folder']} link="Open folder" /></div>
            <div className={styles.profileSection}><h3>Market profile</h3><DetailField label="NAICS codes" value={selected['NAICS Codes']} /><DetailField label="Agencies worked with" value={selected['Agencies Worked with']} /><DetailField label="Contract vehicles" value={selected['Contracts Vehicles']} /><DetailField label="Keywords" value={selected.Keywords} /></div>
            <div className={styles.profileSection}><h3>Capabilities and strengths</h3><DetailField label="Capabilities" value={selected.Capabilities} /><DetailField label="Company strengths" value={selected['Company Strengths']} /></div>
            <div className={styles.profileSection}><h3>Notes</h3><DetailField label="Notes" value={selected.Notes} /></div>
          </div> : <div className={styles.emptyProfile}><div>◇</div><strong>Select a partner</strong><span>Choose one from the list to view its profile, or add a new partner.</span><button className="btn btn-primary" onClick={startAdd}>Add partner</button></div>}
        </section>
      </div>
    </div>
    {deleteTarget && <Modal title="Delete partner" onClose={() => !deleteAction.isLoading && setDeleteTarget(null)} footer={<><button className="btn" disabled={deleteAction.isLoading} onClick={() => setDeleteTarget(null)}>Cancel</button><button className="btn btn-danger" disabled={deleteAction.isLoading} onClick={deletePartner}>{deleteAction.isLoading ? 'Deleting…' : 'Delete'}</button></>}><p className="text-sm">Delete <strong>{deleteTarget['Partner Name']}</strong>? This cannot be undone.</p></Modal>}
  </>
}
