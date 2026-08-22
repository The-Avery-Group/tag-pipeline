import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import Topbar from '@/components/Layout/Topbar'
import Modal from '@/components/Common/Modal'
import ActionIcon from '@/components/Common/ActionIcon'
import CopyValue from '@/components/Common/CopyValue'
import RichText from '@/components/Common/RichText'
import PartnerFilesPanel from '@/components/Partner/PartnerFilesPanel'
import PartnerNotesPanel from '@/components/Partner/PartnerNotesPanel'
import { usePartners } from '@/hooks/usePartners'
import { usePipeline } from '@/hooks/usePipeline'
import { useAsyncAction } from '@/hooks/useAsyncAction'
import { useScrollRestoration } from '@/hooks/useScrollRestoration'
import { buildSearchIndex, filterSearchIndex } from '@/utils/searchHelpers'
import styles from './Partners.module.css'
import { useSaveShortcut } from '@/shortcuts/SaveShortcutContext'

const FIELDS = [
  ['Partner Name', 'Partner name', 'input', true, 'identity'],
  ['UEI Number', 'UEI', 'input', true, 'identity'],
  ['Contact Information', 'Contact details', 'textarea', false, 'contact'],
  ['Link to website', 'Website', 'input', false, 'contact'],
  ['Link to Partner Folder', 'Partner SharePoint folder', 'input', false, 'contact'],
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
const OPPORTUNITY_ID = 'Contract Number / Notice ID'
const OPPORTUNITY_TITLE = 'Project Title / Description*'
const OPPORTUNITY_PHASE = 'TAG Opportunity Phase'
const OPPORTUNITY_INCUMBENT_UEI = 'Incumbent (Company UEI)'
const OPPORTUNITY_PARTNER = 'Partner'

function safeUrl(value) {
  const url = String(value || '').trim()
  return !url ? '' : /^https?:\/\//i.test(url) ? url : `https://${url}`
}

function partnerName(partner) {
  return String(partner?.['Partner Name'] || '').trim() || 'Partner name unavailable'
}

function normalizePartnerMatch(value) {
  // Partner names are entered manually in both tables. Compare the meaningful
  // characters so harmless differences such as "TAG, LLC", "TAG LLC", or
  // "TAG-LLC" still identify the same partner.
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
}

function partnerFieldIncludes(value, name) {
  const target = normalizePartnerMatch(name)
  const source = String(value || '').trim()
  if (!target || !source) return false

  // Check the entire value first. This preserves names that legitimately
  // contain commas, such as "Example Company, LLC".
  if (normalizePartnerMatch(source) === target) return true

  // Multiple partners are normally separated with semicolons or pipes. Keep
  // comma support for existing rows where commas are used as list separators.
  return source
    .split(/[;|]/)
    .flatMap((item) => [item, ...item.split(',')])
    .some((item) => normalizePartnerMatch(item) === target)
}

function DetailField({ label, value, link, rich = false }) {
  if (!value) return null
  const content = link
    ? <a href={safeUrl(value)} target="_blank" rel="noreferrer">{link}</a>
    : rich ? <RichText value={value} /> : value
  return <div className={styles.detailField}><span>{label}</span><div><CopyValue value={value} label={label}>{content}</CopyValue></div></div>
}

export default function Partners({ toast }) {
  const { partners, loading, error, refresh, add, update, remove } = usePartners()
  const { pipeline } = usePipeline()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const listPanelRef = useRef(null)
  useScrollRestoration(listPanelRef)
  const [search, setSearch] = useState(() => searchParams.get('search') || '')
  const [selected, setSelected] = useState(null)
  const [form, setForm] = useState(EMPTY)
  const [editing, setEditing] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState(null)
  const saveAction = useAsyncAction()
  const deleteAction = useAsyncAction()

  const partnerSearchIndex = useMemo(() => buildSearchIndex(partners), [partners])
  const filtered = useMemo(() => (
    filterSearchIndex(partnerSearchIndex, search)
      .slice()
      .sort((a, b) => partnerName(a).localeCompare(partnerName(b), undefined, { sensitivity: 'base' }))
  ), [partnerSearchIndex, search])
  const requestedPartnerUEI = String(searchParams.get('partner') || '').trim().toUpperCase()
  useEffect(() => {
    if (!requestedPartnerUEI) return
    const match = partners.find((partner) => String(partner['UEI Number'] || '').trim().toUpperCase() === requestedPartnerUEI)
    if (match) {
      setSelected((current) => current?._rowIndex === match._rowIndex ? { ...current, ...match } : match)
      if (match._rowIndex !== selected?._rowIndex) setEditing(false)
    }
  }, [partners, requestedPartnerUEI, selected?._rowIndex])
  const matchedOpportunities = useMemo(() => {
    const uei = String(selected?.['UEI Number'] || '').trim().toUpperCase()
    const name = selected?.['Partner Name'] || ''
    if (!uei && !name) return []
    return pipeline.flatMap((opportunity) => {
      const incumbentMatch = Boolean(uei) && String(opportunity[OPPORTUNITY_INCUMBENT_UEI] || '').trim().toUpperCase() === uei
      const partnerFieldMatch = partnerFieldIncludes(opportunity[OPPORTUNITY_PARTNER], name)
      if (!incumbentMatch && !partnerFieldMatch) return []
      return [{ opportunity, matchLabel: incumbentMatch && partnerFieldMatch ? 'Matched as incumbent and listed partner' : incumbentMatch ? 'Matched by incumbent UEI' : 'Listed as partner' }]
    })
  }, [pipeline, selected])
  const select = (partner) => {
    setSelected(partner); setEditing(false)
    setSearchParams((current) => {
      const next = new URLSearchParams(current)
      next.set('partner', String(partner['UEI Number'] || '').trim().toUpperCase())
      return next
    }, { replace: true })
  }
  const startAdd = () => {
    setSelected(null); setForm(EMPTY()); setEditing(true)
    setSearchParams((current) => { const next = new URLSearchParams(current); next.delete('partner'); return next }, { replace: true })
  }
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
  useSaveShortcut({
    enabled: editing && !saveAction.isLoading,
    label: selected ? 'these partner changes' : 'this new partner',
    onSave: save,
  })
  const deletePartner = async () => {
    try {
      await deleteAction.run(() => remove(deleteTarget._rowIndex, deleteTarget), { onError: (err) => toast?.error(`Failed: ${err.message}`) })
      if (selected?._rowIndex === deleteTarget._rowIndex) {
        setSelected(null)
        setSearchParams((current) => { const next = new URLSearchParams(current); next.delete('partner'); return next }, { replace: true })
      }
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
        <aside ref={listPanelRef} className={styles.listPanel}>
          <div className={styles.searchBar}><input className={styles.searchInput} placeholder="Search partners…" value={search} onChange={(event) => setSearchValue(event.target.value)} /><span>{filtered.length}</span></div>
          {loading ? <div className={styles.listMessage}>Loading partners…</div> : error ? <div className={styles.listMessage}>Could not load partners.<button className="btn btn-ghost text-sm" onClick={refresh}>Retry</button></div> : filtered.length === 0 ? <div className={styles.listMessage}>{search ? 'No matches.' : 'No partners yet.'}</div> : <div className={styles.partnerList}>{filtered.map((partner) => <button key={partner._rowIndex} className={`${styles.listItem} ${selected?._rowIndex === partner._rowIndex ? styles.listItemActive : ''}`} onClick={() => select(partner)}><strong>{partnerName(partner)}</strong><span>UEI: {partner['UEI Number']}</span>{partner.Capabilities && <small>{partner.Capabilities}</small>}</button>)}</div>}
        </aside>
        <section className={styles.profilePanel}>
          {editing ? <div className={styles.editProfile}>
            <div className={styles.profileHeader}><div><h2>{selected ? 'Edit partner' : 'New partner'}</h2><p>UEI is the unique identifier used for incumbent matching.</p></div></div>
            {SECTIONS.map(([id]) => formSection(id))}
            <div className={styles.profileActions}><button className="btn" disabled={saveAction.isLoading} onClick={() => { setEditing(false); if (!selected) setForm(EMPTY()) }}>Cancel</button><button className="btn btn-primary" disabled={saveAction.isLoading} onClick={save}>{saveAction.isLoading ? 'Saving…' : selected ? 'Save changes' : 'Add partner'}</button></div>
          </div> : selected ? <div className={styles.profile}>
            <div className={styles.profileHeader}><div><div className={styles.eyebrow}>Partner profile</div><h2>{partnerName(selected)}</h2><p>UEI: <CopyValue value={selected['UEI Number']} label="UEI">{selected['UEI Number']}</CopyValue></p></div><div className={styles.headerActions}><button className="btn text-sm" onClick={startEdit}><ActionIcon name="edit" /> Edit</button><button className="btn btn-ghost text-sm" style={{ color: 'var(--red-600)' }} onClick={() => setDeleteTarget(selected)}>Delete</button></div></div>
            <div className={styles.profileSection}><h3>Contact and links</h3><DetailField label="Contact details" value={selected['Contact Information']} /><DetailField label="Website" value={selected['Link to website']} link="Open website" /><DetailField label="Partner SharePoint folder" value={selected['Link to Partner Folder']} link="Open folder" /></div>
            <div className={styles.profileSection}><h3>Market profile</h3><DetailField label="NAICS codes" value={selected['NAICS Codes']} /><DetailField label="Agencies worked with" value={selected['Agencies Worked with']} /><DetailField label="Contract vehicles" value={selected['Contracts Vehicles']} /><DetailField label="Keywords" value={selected.Keywords} /></div>
            <div className={styles.profileSection}><h3>Capabilities and strengths</h3><DetailField label="Capabilities" value={selected.Capabilities} /><DetailField label="Company strengths" value={selected['Company Strengths']} /></div>
            <PartnerNotesPanel key={`partner-notes-${selected['UEI Number']}`} partner={selected} toast={toast} />
            <PartnerFilesPanel key={`partner-files-${selected['UEI Number']}`} partner={selected} />
            <div className={`${styles.profileSection} ${styles.matchedOpportunities}`}><h3>Matched opportunities</h3>{matchedOpportunities.length === 0 ? <p className="text-sm text-muted">No pipeline opportunities match this partner’s UEI or name.</p> : matchedOpportunities.map(({ opportunity, matchLabel }) => <button type="button" key={opportunity._rowIndex || opportunity[OPPORTUNITY_ID]} className={styles.matchedOpportunity} onClick={() => navigate(`/opportunities/${encodeURIComponent(opportunity[OPPORTUNITY_ID])}?row=${opportunity._rowIndex}`)}><span><strong>{opportunity[OPPORTUNITY_TITLE] || 'Untitled opportunity'}</strong><small>{opportunity[OPPORTUNITY_ID]} · {matchLabel}</small></span><em>{opportunity[OPPORTUNITY_PHASE] || 'View opportunity'} ↗</em></button>)}</div>
          </div> : <div className={styles.emptyProfile}><div>◇</div><strong>Select a partner</strong><span>Choose one from the list to view its profile, or add a new partner.</span><button className="btn btn-primary" onClick={startAdd}>Add partner</button></div>}
        </section>
      </div>
    </div>
    {deleteTarget && <Modal title="Delete partner" onClose={() => !deleteAction.isLoading && setDeleteTarget(null)} footer={<><button className="btn" disabled={deleteAction.isLoading} onClick={() => setDeleteTarget(null)}>Cancel</button><button className="btn btn-danger" disabled={deleteAction.isLoading} onClick={deletePartner}>{deleteAction.isLoading ? 'Deleting…' : 'Delete'}</button></>}><p className="text-sm">Delete <strong>{deleteTarget['Partner Name']}</strong>? This cannot be undone.</p></Modal>}
  </>
}
