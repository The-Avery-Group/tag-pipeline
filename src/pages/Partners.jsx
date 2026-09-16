import AutoTextarea from '@/components/Common/AutoTextarea'
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
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
import { groupPartners, partnerGroupKey, sharedPartnerWorkspace, partnerRefreshEnabled, partnerRefreshDue, partnerRefreshQueue } from '@/utils/partnerGroups'
import { getPartnerEnrichment, refreshPartnerEnrichment, refreshAllPartnerEnrichment } from '@/services/partnerWorkspaceService'
import { formatDate, formatDateTime } from '@/utils/kpiHelpers'
import { dateOnly } from '@/utils/opportunityDates'
import styles from './Partners.module.css'
import { useSaveShortcut } from '@/shortcuts/SaveShortcutContext'

const FIELDS = [
  ['Partner Name', 'Partner name', 'input', true, 'identity'],
  ['UEI Number', 'UEI', 'input', true, 'identity'],
  ['Partner Group', 'Company group (same name for each subsidiary)', 'input', false, 'identity'],
  ['USAspending Enabled', 'Quarterly USAspending refresh (on by default)', 'checkbox', false, 'identity'],
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

function vehicleDate(value) {
  const formatted = formatDate(dateOnly(value))
  return formatted === '-' ? 'Not reported' : formatted
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
  const [enrichmentResult, setEnrichment] = useState(null)
  const [enrichmentError, setEnrichmentError] = useState('')
  const refreshJobs = useSyncExternalStore(partnerRefreshQueue.subscribe, partnerRefreshQueue.getSnapshot)
  const [pollVersion, setPollVersion] = useState(0)
  const selectedUEI = String(selected?.['UEI Number'] || '').trim().toUpperCase()
  const activeUEI = useRef(selectedUEI)
  activeUEI.current = selectedUEI
  const enrichment = enrichmentResult?.uei === selectedUEI ? enrichmentResult : null
  const refreshJob = refreshJobs.find(job => job.partnerId ? job.partnerId === selected?.['Partner ID'] : job.uei === selectedUEI)
  const refreshing = ['queued', 'running'].includes(refreshJob?.status)
  const refreshEnabled = partnerRefreshEnabled(selected)
  useEffect(() => {
    let disposed = false
    if (['queued', 'running'].includes(refreshJob?.status)) setEnrichmentError('')
    if (refreshJob?.status === 'complete') {
      getPartnerEnrichment(selectedUEI).then(result => {
        if (!disposed) { setEnrichment(result); setEnrichmentError('') }
      }).catch(err => { if (!disposed) setEnrichmentError(err.message) })
    }
    return () => { disposed = true }
  }, [selectedUEI, refreshJob?.status])
  useEffect(() => {
    setEnrichment(null); setEnrichmentError('')
    if (!/^[A-Z0-9]{12}$/.test(selectedUEI)) return undefined
    let disposed = false
    const load = async () => {
      try {
        const saved = await getPartnerEnrichment(selectedUEI)
        if (disposed) return
        setEnrichment(saved)
        const existing = partnerRefreshQueue.getSnapshot().find(job => job.partnerId ? job.partnerId === selected?.['Partner ID'] : job.uei === selectedUEI)
        if (!partnerRefreshDue(saved.partner) && !['queued', 'running'].includes(existing?.status)) return
        if (existing?.status === 'failed') return
        const result = await refreshPartnerEnrichment(selectedUEI, { automatic: true, partnerId: saved.partner['Partner ID'], name: partnerName(saved.partner) })
        if (!disposed) setEnrichment(result)
      } catch (err) { if (!disposed) setEnrichmentError(err.message) }
    }
    load()
    return () => { disposed = true }
  }, [selectedUEI, pollVersion])
  const refreshEnrichment = async () => {
    const uei = selectedUEI
    setEnrichmentError('')
    try {
      const result = await refreshPartnerEnrichment(uei, { name: partnerName(selected), partnerId: selected?.['Partner ID'] })
      if (activeUEI.current === uei) setEnrichment(result)
      if (!result.skipped) toast?.success('Partner USAspending information saved to workbook')
    }
    catch (err) { if (activeUEI.current === uei) setEnrichmentError(err.message) }
  }

  const partnerSearchIndex = useMemo(() => buildSearchIndex(partners), [partners])
  const filtered = useMemo(() => (
    filterSearchIndex(partnerSearchIndex, search)
      .slice()
      .sort((a, b) => partnerName(a).localeCompare(partnerName(b), undefined, { sensitivity: 'base' }))
  ), [partnerSearchIndex, search])
  const groups = useMemo(() => groupPartners(partners), [partners])
  const visibleGroups = useMemo(() => {
    const matches = new Set(filtered.map(p => p['Partner ID']))
    return groups.filter(group => group.members.some(p => matches.has(p['Partner ID'])))
  }, [groups, filtered])
  const selectedGroup = groups.find(group => group.key === partnerGroupKey(selected))
  const groupMembers = selectedGroup?.members || []
  const sharedWorkspace = sharedPartnerWorkspace(groupMembers)
  const requestedPartnerUEI = String(searchParams.get('partner') || '').trim().toUpperCase()
  useEffect(() => {
    if (!requestedPartnerUEI) return
    const match = partners.find((partner) => [partner['Partner ID'], partner['UEI Number']].some(value => String(value || '').trim().toUpperCase() === requestedPartnerUEI))
    if (match) {
      setSelected((current) => current?.['Partner ID'] === match['Partner ID'] ? { ...current, ...match } : match)
      if (match['Partner ID'] !== selected?.['Partner ID']) setEditing(false)
    }
  }, [partners, requestedPartnerUEI, selected?.['Partner ID']])
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
      next.set('partner', String(partner['Partner ID'] || partner['UEI Number'] || '').trim())
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
    if (partners.some((partner) => partner['Partner ID'] !== selected?.['Partner ID'] && String(partner['UEI Number'] || '').trim().toUpperCase() === uei)) {
      toast?.error('A partner with that UEI already exists'); return
    }
    // Do not resubmit a stale copy of machine-owned fields or unknown workbook columns.
    const next = { ...Object.fromEntries(FIELDS.map(([key]) => [key, form[key] || ''])), 'Partner Name': name, 'UEI Number': uei }
    try {
      await saveAction.run(() => selected ? update(selected, next, selected) : add(next), { onError: (err) => toast?.error(`Failed: ${err.message}`) })
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
      await deleteAction.run(() => remove(deleteTarget, deleteTarget), { onError: (err) => toast?.error(`Failed: ${err.message}`) })
      if (selected?.['Partner ID'] === deleteTarget['Partner ID']) {
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
        {type === 'checkbox' ? <input aria-label={label} type="checkbox" checked={['', 'yes'].includes(String(form[key] || '').trim().toLowerCase())} onChange={event => setForm(current => ({ ...current, [key]: event.target.checked ? 'Yes' : 'No' }))} /> : type === 'textarea' ? <AutoTextarea className="form-input" rows={3} value={form[key] || ''} onChange={(event) => setForm((current) => ({ ...current, [key]: event.target.value }))} /> : <input className="form-input" value={form[key] || ''} onChange={(event) => setForm((current) => ({ ...current, [key]: event.target.value }))} />}
      </div>)}</div>
    </div>
  )

  return <>
    <Topbar title="Partners" subtitle1={`${groups.length} partner pages · ${partners.length} entities`} showFilter={false} showNew newLabel="New partner" onNew={startAdd} />
    <div className={`page-body ${styles.page}`}>
      <div className={`card ${styles.workspace}`}>
        <aside ref={listPanelRef} className={styles.listPanel}>
          <div className={styles.searchBar}><input className={styles.searchInput} placeholder="Search partners…" value={search} onChange={(event) => setSearchValue(event.target.value)} /><span>{visibleGroups.length}</span></div>
          {loading ? <div className={styles.listMessage}>Loading partners…</div> : error ? <div className={styles.listMessage} role="alert"><strong>Could not load partners.</strong><p className="text-sm">{error}</p><button className="btn btn-ghost text-sm" onClick={refresh}>Retry</button></div> : visibleGroups.length === 0 ? <div className={styles.listMessage}>{search ? 'No matches.' : 'No partners yet.'}</div> : <div className={styles.partnerList}>{visibleGroups.map(group => <button key={group.key} className={`${styles.listItem} ${selectedGroup?.key === group.key ? styles.listItemActive : ''}`} onClick={() => select(group.members.find(p => filtered.some(match => match['Partner ID'] === p['Partner ID'])) || group.members[0])}><strong>{group.name}</strong><span>{group.members.length > 1 ? `${group.members.length} subsidiaries` : `UEI: ${group.members[0]['UEI Number']}`}</span><small>{group.members.map(p => p.Capabilities).filter(Boolean).join(' · ')}</small></button>)}</div>}
        </aside>
        <section className={styles.profilePanel}>
          {editing ? <div className={styles.editProfile}>
            <div className={styles.profileHeader}><div><h2>{selected ? 'Edit partner' : 'New partner'}</h2><p>UEI is the unique identifier used for incumbent matching.</p></div></div>
            {SECTIONS.map(([id]) => formSection(id))}
            <div className={styles.profileActions}><button className="btn" disabled={saveAction.isLoading} onClick={() => { setEditing(false); if (!selected) setForm(EMPTY()) }}>Cancel</button><button className="btn btn-primary" disabled={saveAction.isLoading} onClick={save}>{saveAction.isLoading ? 'Saving…' : selected ? 'Save changes' : 'Add partner'}</button></div>
          </div> : selected ? <div className={styles.profile}>
            {selectedGroup?.name !== partnerName(selected) && <h2 className={styles.groupTitle}>{selectedGroup?.name}</h2>}
            {groupMembers.length > 1 && <div className={styles.entitySelector}><label htmlFor="partner-entity">Subsidiary</label><select id="partner-entity" className="form-input" value={selected['Partner ID']} onChange={event => select(groupMembers.find(p => String(p['Partner ID']) === event.target.value))}>{groupMembers.map(p => <option key={p['Partner ID']} value={p['Partner ID']}>{partnerName(p)} · {p['UEI Number']}</option>)}</select><small>Agency history, vehicles, notes and edits below belong to this legal entity.</small></div>}
            <div className={styles.profileHeader}><div><div className={styles.eyebrow}>Partner profile</div><h2>{partnerName(selected)}</h2><p>UEI: <CopyValue value={selected['UEI Number']} label="UEI">{selected['UEI Number']}</CopyValue></p></div><div className={styles.headerActions}><button className="btn text-sm" onClick={startEdit}><ActionIcon name="edit" /> Edit</button><button className="btn btn-danger-ghost text-sm"  onClick={() => setDeleteTarget(selected)}>Delete</button></div></div>
            <div className={styles.profileSection}><h3>Contact and links</h3><DetailField label="Contact details" value={selected['Contact Information']} /><DetailField label="Website" value={selected['Link to website']} link="Open website" /><DetailField label="Partner SharePoint folder" value={selected['Link to Partner Folder']} link="Open folder" /></div>
            <div className={styles.profileSection}><h3>Market profile</h3><DetailField label="NAICS codes" value={selected['NAICS Codes']} /><DetailField label="Agencies worked with" value={selected['Agencies Worked with']} /><DetailField label="Contract vehicles" value={selected['Contracts Vehicles']} /><DetailField label="Keywords" value={selected.Keywords} /></div>
            <div className={styles.profileSection}><h3>Capabilities and strengths</h3><DetailField label="Capabilities" value={selected.Capabilities} /><DetailField label="Company strengths" value={selected['Company Strengths']} /></div>
            <details className={styles.enrichmentSection} open><summary>Agency history and contract vehicles</summary><div className={styles.enrichmentBody}>
              <small className={styles.researchSource}>Source: USAspending</small>
              <details className={styles.refreshSettings} key={`refresh-settings-${selectedUEI}`}><summary>Refresh settings</summary><div className={styles.refreshSettingsBody}>
              <div className={styles.headerActions}><button className="btn text-sm" disabled={refreshing || !refreshEnabled || !/^[A-Z0-9]{12}$/.test(selectedUEI)} onClick={refreshEnrichment}>{refreshing ? refreshJob.status === 'queued' ? 'Queued' : 'Refreshing…' : 'Refresh USAspending'}</button><button className="btn text-sm" onClick={() => { void refreshAllPartnerEnrichment(partners); toast?.success('Enabled partners with valid UEIs added to the refresh queue') }}>Refresh all partners</button></div>
              {(!refreshEnabled || !/^[A-Z0-9]{12}$/.test(selectedUEI)) && <p className="text-sm text-muted">{/^[A-Z0-9]{12}$/.test(selectedUEI) ? 'USAspending refresh is turned off for this partner.' : 'Add a valid 12-character UEI to refresh this partner.'}</p>}
              <label className="text-sm"><input type="checkbox" checked={refreshEnabled} disabled={saveAction.isLoading} onChange={async event => {
                const partner = selected
                const patch = { 'USAspending Enabled': event.target.checked ? 'Yes' : 'No' }
                setSelected(current => current?.['Partner ID'] === partner['Partner ID'] ? { ...current, ...patch } : current)
                try { await saveAction.run(() => update(partner, patch, partner)); setPollVersion(v => v + 1) }
                catch (err) { setSelected(current => current?.['Partner ID'] === partner['Partner ID'] ? partner : current); toast?.error(`Could not save refresh setting: ${err.message}`) }
              }} /> Quarterly refresh</label>
              <small className={styles.researchSource}>Last successful refresh: {enrichment?.snapshot?.checkedAt || selected['USAspending Refreshed At'] ? formatDateTime(enrichment?.snapshot?.checkedAt || selected['USAspending Refreshed At']) : 'Not yet refreshed'}</small>
              </div></details>
              {refreshing && <p className={styles.researchSource} role="status">{refreshJob.status === 'queued' ? 'Queued for a background update.' : 'Updating in the background.'} You can continue using the CRM.</p>}
              {(enrichmentError || refreshJob?.error) && <p className="text-sm text-muted">{enrichmentError || refreshJob.error}</p>}
              <DetailField label="Reported agencies (last five years)" value={enrichment?.snapshot ? enrichment.snapshot.agencies.map(a => a.name).join('\n') || 'None reported' : String(selected['USAspending Agencies'] || '').split(',').map(name => name.trim()).filter(Boolean).join('\n')} />
              {enrichment?.snapshot?.vehicles?.length > 0 && <div className={styles.vehicleTable} tabIndex={0} role="region" aria-label="Contract vehicles"><table aria-label="Reported contract vehicles and dates"><thead><tr><th scope="col">Contract vehicle / PIID</th><th scope="col">Current end date</th></tr></thead><tbody>{enrichment.snapshot.vehicles.map(vehicle => <tr key={vehicle['Record ID']}><td><a href={vehicle['Source Link']} target="_blank" rel="noreferrer">{vehicle['Vehicle Name'] || 'Unresolved vehicle'}</a><span className={styles.vehiclePiid}>{vehicle.PIID}</span></td><td>{vehicleDate(vehicle['Current End Date'])}</td></tr>)}</tbody></table></div>}
              <p className={styles.researchNote}>Direct vehicle awards and reported parent references. References do not prove direct holding. Dates do not establish current ordering eligibility.</p>
            </div></details>
            <PartnerNotesPanel key={`partner-notes-${selected['UEI Number']}`} partner={selected} toast={toast} />
            {sharedWorkspace.conflict && <p className="text-sm text-muted">This group has different folder links. Existing folders remain separate; select a subsidiary to view its files.</p>}
            {groupMembers.length > 1 && !sharedWorkspace.partner && !sharedWorkspace.conflict ? <p className="text-sm text-muted">Add the existing shared folder link to a group member using Edit. The app will use that folder for the group without creating subsidiary folders.</p> : <PartnerFilesPanel key={`partner-files-${(sharedWorkspace.partner || selected)['UEI Number']}`} partner={sharedWorkspace.partner || selected} onCreated={async () => { await refresh() }} />}
            <div className={`${styles.profileSection} ${styles.matchedOpportunities}`}><h3>Matched opportunities</h3>{matchedOpportunities.length === 0 ? <p className="text-sm text-muted">No pipeline opportunities match this partner’s UEI or name.</p> : matchedOpportunities.map(({ opportunity, matchLabel }) => <button type="button" key={opportunity['Opportunity ID'] || opportunity[OPPORTUNITY_ID]} className={styles.matchedOpportunity} onClick={() => navigate(`/opportunities/${encodeURIComponent(opportunity[OPPORTUNITY_ID])}`)}><span><strong>{opportunity[OPPORTUNITY_TITLE] || 'Untitled opportunity'}</strong><small>{opportunity[OPPORTUNITY_ID]} · {matchLabel}</small></span><em>{opportunity[OPPORTUNITY_PHASE] || 'View opportunity'} ↗</em></button>)}</div>
          </div> : <div className={styles.emptyProfile}><div>◇</div><strong>Select a partner</strong><span>Choose one from the list to view its profile, or add a new partner.</span><button className="btn btn-primary" onClick={startAdd}>Add partner</button></div>}
        </section>
      </div>
    </div>
    {deleteTarget && <Modal title="Delete partner" onClose={() => !deleteAction.isLoading && setDeleteTarget(null)} footer={<><button className="btn" disabled={deleteAction.isLoading} onClick={() => setDeleteTarget(null)}>Cancel</button><button className="btn btn-danger" disabled={deleteAction.isLoading} onClick={deletePartner}>{deleteAction.isLoading ? 'Deleting…' : 'Delete'}</button></>}><p className="text-sm">Delete <strong>{deleteTarget['Partner Name']}</strong>? This cannot be undone.</p></Modal>}
  </>
}
