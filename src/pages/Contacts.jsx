import { useState, useMemo, useCallback, useEffect } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useContacts } from '@/hooks/useContacts'
import { useContactEngagement } from '@/hooks/useContactEngagement'
import { usePipeline } from '@/hooks/usePipeline'
import { useAsyncAction, useAsyncActionKeyed } from '@/hooks/useAsyncAction'
import Topbar from '@/components/Layout/Topbar'
import Modal from '@/components/Common/Modal'
import { useValidationLists, pickList } from '@/hooks/useValidationLists'
import { CONTACT_TYPES } from '@/services/graphService'
import { parsePOCNames, addContactToPOC, removeContactFromPOC } from '@/services/graphService'
import { formatDate } from '@/utils/kpiHelpers'
import { recordMatches } from '@/utils/searchHelpers'
import { useAuth } from '@/auth/AuthContext'
import styles from './Contacts.module.css'

const BLANK = { Name: '', Title: '', Agency: '', Organization: '', Offices: '', Email: '', Phone: '', Notes: '', Type: '' }

const C_CN    = 'Contract Number / Notice ID'
const C_TITLE = 'Project Title / Description*'
const C_PHASE = 'TAG Opportunity Phase'
const C_POC   = 'Contracting Officer / Specialist (POC)*'
const todayISO = () => new Date().toISOString().slice(0, 10)
const BLANK_INTERACTION = () => ({ 'Interaction Date': todayISO(), 'Interaction Type': '', Notes: '', 'Follow-up Date': '' })

function isValidDateInput(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return false
  const date = new Date(`${value}T00:00:00`)
  return !Number.isNaN(date.getTime())
}

function datePlusDays(dateValue, days) {
  const [year, month, day] = String(dateValue).split('-').map(Number)
  const date = new Date(year, month - 1, day)
  date.setDate(date.getDate() + days)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

export default function Contacts({ toast }) {
  const { contacts, loading, error, refresh, add, update, remove } = useContacts()
  const { user } = useAuth()
  const { pipeline, update: updateOpp } = usePipeline()
  const { lists } = useValidationLists()
  const contactTypeOptions = pickList(lists, 'Types', CONTACT_TYPES)
  const [searchParams, setSearchParams] = useSearchParams()

  const [search, setSearch] = useState('')
  const [showAdd, setShowAdd] = useState(false)
  const [selected, setSelected] = useState(null)   // contact shown in panel
  const engagement = useContactEngagement(Boolean(selected))
  const [editing, setEditing] = useState(false)    // panel edit mode
  const [form, setForm] = useState(BLANK)
  const [saving, setSaving] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(null)
  const [oppSearch, setOppSearch] = useState('')
  const [showInteractionForm, setShowInteractionForm] = useState(false)
  const [interactionForm, setInteractionForm] = useState(BLANK_INTERACTION)
  const [interactionError, setInteractionError] = useState('')
  const [focusedInteractionId, setFocusedInteractionId] = useState(null)
  // Consistent in-progress feedback + re-entrancy guarding for actions that
  // previously had none (delete, unlink) or used an ad hoc boolean (link).
  const deleteAction = useAsyncAction()
  const linkAction   = useAsyncAction()
  const unlinkAction = useAsyncActionKeyed()   // keyed by contract number — several linked-opp rows can each have their own unlink button
  const interactionAction = useAsyncAction()

  const setField = useCallback((field, value) => {
    setForm((prev) => ({ ...prev, [field]: value }))
  }, [])

  // Close panel on Escape
  useEffect(() => {
    const fn = (e) => { if (e.key === 'Escape') { setSelected(null); setEditing(false) } }
    document.addEventListener('keydown', fn)
    return () => document.removeEventListener('keydown', fn)
  }, [])

  const filtered = useMemo(
    () => contacts.filter(
      (contact) => recordMatches(contact, search)
    ),
    [contacts, search]
  )

  // Opportunities linked to the selected contact (POC column contains their name)
  const linkedOpps = useMemo(() => {
    if (!selected) return []
    return pipeline.filter((o) => parsePOCNames(o[C_POC]).includes(selected.Name))
  }, [selected, pipeline])

  const selectedInteractions = useMemo(() => {
    if (!selected) return []
    return engagement.interactions
      .filter((row) => row.ContactID === selected.ContactID)
      .sort((a, b) => String(b['Interaction Date'] || '').localeCompare(String(a['Interaction Date'] || '')))
  }, [selected, engagement.interactions])

  useEffect(() => {
    const interactionId = searchParams.get('interactionId')
    if (!interactionId || !selected || engagement.loading) return undefined
    const interaction = selectedInteractions.find((row) =>
      String(row.InteractionID || row._rowIndex) === interactionId
    )
    if (!interaction) return undefined
    setFocusedInteractionId(interactionId)
    requestAnimationFrame(() => document.getElementById(`contact-interaction-${interactionId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }))
    setSearchParams((previous) => {
      const next = new URLSearchParams(previous)
      next.delete('interactionId')
      return next
    }, { replace: true })
    const timeout = setTimeout(() => setFocusedInteractionId(null), 3000)
    return () => clearTimeout(timeout)
  }, [searchParams, selected, selectedInteractions, engagement.loading, setSearchParams])

  // Opportunities NOT yet linked to selected contact (for search/add)
  const unlinkableOpps = useMemo(() => {
    if (!selected) return []
    const linked = new Set(linkedOpps.map((o) => o[C_CN]))
    const q = oppSearch.trim().toLowerCase()
    return pipeline.filter((o) => {
      if (linked.has(o[C_CN])) return false
      if (!q) return true
      return [o[C_TITLE], o[C_CN]].some((v) => v?.toLowerCase().includes(q))
    }).slice(0, 30)
  }, [pipeline, linkedOpps, oppSearch, selected])

  const openPanel = (c) => {
    setSelected(c)
    setEditing(false)
    setOppSearch('')
    setShowInteractionForm(false)
    setInteractionForm(BLANK_INTERACTION())
    setInteractionError('')
  }

  // Search results can deep-link directly into the same detail panel opened
  // by clicking a row. Clear the parameter after opening so closing the panel
  // behaves normally instead of immediately reopening it.
  useEffect(() => {
    const contactId = searchParams.get('contactId')
    if (!contactId) return
    const match = contacts.find((contact) =>
      contact.ContactID === contactId || String(contact._rowIndex) === contactId
    )
    if (!match) return
    setSelected(match)
    setEditing(false)
    setOppSearch('')
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev)
      next.delete('contactId')
      return next
    }, { replace: true })
  }, [contacts, searchParams, setSearchParams])

  const startEdit = () => {
    setForm({ ...BLANK, ...selected })
    setEditing(true)
  }

  const cancelEdit = () => {
    setEditing(false)
    setForm(BLANK)
  }

  const saveEdit = async () => {
    setSaving(true)
    try {
      await update(selected._rowIndex, form)
      setSelected((prev) => ({ ...prev, ...form }))
      setEditing(false)
      toast?.success('Contact updated')
    } catch (err) {
      toast?.error(`Failed: ${err.message}`)
    } finally {
      setSaving(false)
    }
  }

  const submitAdd = async () => {
    setSaving(true)
    try {
      await add(form)
      toast?.success('Contact added')
      setShowAdd(false)
      setForm(BLANK)
    } catch (err) {
      toast?.error(`Failed: ${err.message}`)
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async () => {
    try {
      await deleteAction.run(() => remove(selected._rowIndex), {
        onError: (err) => toast?.error(`Failed: ${err.message}`),
      })
      toast?.success('Contact deleted')
      setSelected(null)
      setEditing(false)
      setConfirmDelete(null)
    } catch {
      // Error already toasted via onError — leave the modal open so the user can retry
    }
  }

  const handleLinkOpp = async (opp) => {
    if (linkAction.isLoading) return
    try {
      await linkAction.run(() => addContactToPOC(opp._rowIndex, opp[C_POC], selected.Name), {
        onError: (err) => toast?.error(`Failed: ${err.message}`),
      })
      toast?.success('Opportunity linked')
      setOppSearch('')
    } catch {
      // already toasted via onError
    }
  }

  const handleUnlinkOpp = async (opp) => {
    try {
      await unlinkAction.run(opp[C_CN], () => removeContactFromPOC(opp._rowIndex, opp[C_POC], selected.Name), {
        onError: (err) => toast?.error(`Failed: ${err.message}`),
      })
      toast?.success('Opportunity unlinked')
    } catch {
      // already toasted via onError
    }
  }

  const handleAddInteraction = async () => {
    const interactionDate = String(interactionForm['Interaction Date'] || '').trim()
    const interactionType = String(interactionForm['Interaction Type'] || '').trim()
    if (!isValidDateInput(interactionDate) || !interactionType) {
      setInteractionError('Choose a valid interaction date and interaction type before saving.')
      return
    }
    if (['Other', 'Event'].includes(interactionType) && !interactionForm.Notes.trim()) {
      setInteractionError(`Add notes to describe an interaction marked as ${interactionType}.`)
      return
    }
    setInteractionError('')
    try {
      await interactionAction.run(async () => {
        await engagement.addInteraction({
          ContactID: selected.ContactID,
          ...interactionForm,
          'Interaction Date': interactionDate,
          'Interaction Type': interactionType,
          'Follow-up Date': String(interactionForm['Follow-up Date'] || '').trim() || datePlusDays(interactionDate, 31),
          'Logged By': user?.displayName || user?.email || 'Unknown user',
        })
        setInteractionForm(BLANK_INTERACTION())
        setShowInteractionForm(false)
        toast?.success('Interaction logged')
      }, {
        onError: (err) => {
          setInteractionError(`Could not log interaction: ${err.message}`)
          toast?.error(`Failed: ${err.message}`)
        },
      })
    } catch {
      // The action wrapper has already shown the error.
    }
  }

  const contactFormFields = () => (
    <div className={styles.formGrid}>
      {[
        ['Name',         'Name',                     true],
        ['Agency',       'Agency / Company (Account)', false],
        ['Title',        'Title',                    false],
        ['Organization', 'Department / Organization', false],
        ['Offices',      'Offices (comma-separated)', false],
        ['Email',        'Email',                    false],
        ['Phone',        'Phone',                    false],
      ].map(([field, label, required]) => (
        <div className="form-field" key={field}>
          <label className="form-label">{label}{required && ' *'}</label>
          <input className="form-input" required={required}
            value={form[field] ?? ''}
            onChange={(e) => setField(field, e.target.value)} />
        </div>
      ))}
      <div className="form-field">
        <label className="form-label">Type</label>
        <select className="form-input" value={form.Type || contactTypeOptions[0] || ''}
          onChange={(e) => setField('Type', e.target.value)}>
          {contactTypeOptions.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
      </div>
      <div className="form-field" style={{ gridColumn: '1 / -1' }}>
        <label className="form-label">Notes / linked contract #</label>
        <textarea className="form-input" rows={2}
          value={form.Notes ?? ''}
          onChange={(e) => setField('Notes', e.target.value)} />
      </div>
    </div>
  )

  const avatar = (name) => name?.split(' ').map((n) => n[0]).slice(0, 2).join('') || '?'

  return (
    <>
      <Topbar
        title="Contacts"
        subtitle1={`${contacts.length} contacts`}
        showFilter={false}
        showNew={true}
        newLabel="New contact"
        onNew={() => { setForm(BLANK); setShowAdd(true) }}
      />
      <div className="page-body" style={{ position: 'relative' }}>
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <div className={styles.searchBar}>
            <input className={styles.searchInput}
              placeholder="Search contacts…"
              value={search}
              onChange={(e) => setSearch(e.target.value)} />
            <span className="text-xs text-muted">{filtered.length} contacts</span>
          </div>

          {loading
            ? <div style={{ padding: 20 }}><div className="skeleton" style={{ height: 200 }} /></div>
            : error
              ? <div style={{ padding: 24, textAlign: 'center', color: 'var(--gray-500)', fontSize: 13 }}>
                  <p style={{ margin: '0 0 10px' }}>Could not load contacts: {error}</p>
                  <button className="btn" onClick={refresh}>Retry</button>
                </div>
            : filtered.length === 0
              ? <div style={{ padding: 24, textAlign: 'center', color: 'var(--gray-400)', fontSize: 13 }}>
                  {search ? 'No contacts match your search.' : 'No contacts yet. Add your first contact.'}
                </div>
              : (
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Agency / Company</th>
                      <th>Title</th>
                      <th>Type</th>
                      <th>Dept / Organization</th>
                      <th>Email</th>
                      <th>Phone</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((c) => (
                      <tr key={c.ContactID}
                        className={selected?.ContactID === c.ContactID ? styles.rowActive : ''}
                        onClick={() => openPanel(c)}>
                        <td>
                          <div className={styles.nameCell}>
                            <div className={styles.avatar}>{avatar(c.Name)}</div>
                            <span style={{ fontWeight: 500 }}>{c.Name}</span>
                          </div>
                        </td>
                        <td className="text-sm">{c.Agency}</td>
                        <td className="text-sm text-muted">{c.Title}</td>
                        <td>{c.Type && <span className="badge badge-tracking">{c.Type}</span>}</td>
                        <td className="text-sm">{c.Organization}</td>
                        <td>
                          <a href={`mailto:${c.Email}`}
                            onClick={(e) => e.stopPropagation()}
                            className="text-sm">{c.Email}</a>
                        </td>
                        <td className="text-sm text-muted">{c.Phone}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )
          }
        </div>

        {/* ── Side panel ── */}
        {selected && (
          <>
            <div className={styles.panelBackdrop} onClick={() => { setSelected(null); setEditing(false) }} />
            <div className={styles.panel}>
              {/* Panel header */}
              <div className={styles.panelHeader}>
                <div className={styles.panelAvatar}>{avatar(selected.Name)}</div>
                <div className={styles.panelHeaderInfo}>
                  <div className={styles.panelName}>{selected.Name}</div>
                  {selected.Title && (
                    <div className={styles.panelSub}>{selected.Title}{selected.Agency ? ` · ${selected.Agency}` : ''}</div>
                  )}
                </div>
                <button className={styles.panelClose}
                  onClick={() => { setSelected(null); setEditing(false) }}>✕</button>
              </div>

              <div className={styles.panelBody}>
                {!editing ? (
                  <>
                    {/* View mode */}
                    <div className={styles.panelSection}>
                      {[
                        ['Email',        selected.Email],
                        ['Phone',        selected.Phone],
                        ['Agency',       selected.Agency],
                        ['Organization', selected.Organization],
                        ['Offices',      selected.Offices],
                        ['Type',         selected.Type],
                        ['Notes',        selected.Notes],
                      ].filter(([, v]) => v).map(([label, value]) => (
                        <div key={label} className={styles.panelField}>
                          <span className={styles.panelLabel}>{label}</span>
                          <span className={styles.panelValue}>
                            {label === 'Email'
                              ? <a href={`mailto:${value}`} className="text-sm">{value}</a>
                              : value}
                          </span>
                        </div>
                      ))}
                    </div>

                    <div className={styles.panelSection}>
                      <div className={styles.panelSectionTitle}>Interactions</div>
                      {engagement.loading
                        ? <p className="text-sm text-muted">Loading interaction history…</p>
                        : engagement.error
                          ? <div className="text-sm text-muted">Could not load interaction history: {engagement.error} <button type="button" className="btn btn-ghost text-sm" onClick={engagement.refresh}>Retry</button></div>
                          : !engagement.interactionsConfigured
                            ? <p className="text-sm text-muted">Interaction logging is not configured yet.</p>
                        : <>
                            {showInteractionForm ? (
                              <div className={styles.interactionForm}>
                                <div className={styles.interactionFormTitle}>New interaction</div>
                                <p className={styles.interactionHint}>Date and type are required. Notes are required for Event or Other. Leave follow-up blank to schedule it 31 days after this interaction.</p>
                                <div className={styles.formGrid}>
                                  <div className="form-field"><label className="form-label">Date *</label><input className="form-input" type="date" required value={interactionForm['Interaction Date']} onChange={(e) => { setInteractionForm((prev) => ({ ...prev, 'Interaction Date': e.target.value })); if (interactionError) setInteractionError('') }} /></div>
                                  <div className="form-field"><label className="form-label">Type *</label><select className="form-input" required value={interactionForm['Interaction Type']} onChange={(e) => { setInteractionForm((prev) => ({ ...prev, 'Interaction Type': e.target.value })); if (interactionError) setInteractionError('') }}><option value="" disabled>Select type</option><option>Email</option><option>Call</option><option>Meeting</option><option>Event</option><option>Other</option></select></div>
                                  <div className="form-field" style={{ gridColumn: '1 / -1' }}><label className="form-label">Notes{['Other', 'Event'].includes(interactionForm['Interaction Type']) ? ' *' : ''}</label><textarea className="form-input" rows={3} value={interactionForm.Notes} onChange={(e) => { setInteractionForm((prev) => ({ ...prev, Notes: e.target.value })); if (interactionError) setInteractionError('') }} /></div>
                                  <div className="form-field"><label className="form-label">Follow-up date</label><input className="form-input" type="date" value={interactionForm['Follow-up Date']} onChange={(e) => setInteractionForm((prev) => ({ ...prev, 'Follow-up Date': e.target.value }))} /></div>
                                </div>
                                {interactionError && <p className={styles.interactionError} role="alert">{interactionError}</p>}
                                <div className={styles.inlineActions}><button type="button" className="btn btn-primary" onClick={handleAddInteraction} disabled={interactionAction.isLoading} aria-busy={interactionAction.isLoading}>{interactionAction.isLoading ? 'Logging interaction…' : 'Save interaction'}</button><button type="button" className="btn" onClick={() => { setShowInteractionForm(false); setInteractionError('') }} disabled={interactionAction.isLoading}>Cancel</button></div>
                              </div>
                            ) : <button type="button" className="btn btn-primary" onClick={() => { setInteractionForm(BLANK_INTERACTION()); setInteractionError(''); setShowInteractionForm(true) }}>{selectedInteractions.length ? 'Log another interaction' : 'Log interaction'}</button>}
                            {selectedInteractions.length === 0
                              ? <p className="text-sm text-muted">No interactions logged.</p>
                              : selectedInteractions.map((row) => (
                                <div id={`contact-interaction-${row.InteractionID || row._rowIndex}`} key={row.InteractionID || row._rowIndex} className={`${styles.interactionRow} ${String(row.InteractionID || row._rowIndex) === focusedInteractionId ? styles.interactionFocused : ''}`}>
                                  <div><strong>{row['Interaction Type'] || 'Interaction'}</strong><span>{formatDate(row['Interaction Date'])}{row['Logged By'] ? ` · ${row['Logged By']}` : ''}</span></div>
                                  <p>{row.Notes}</p>
                                  {row['Follow-up Date'] && <small>Follow up {formatDate(row['Follow-up Date'])}</small>}
                                </div>
                              ))}
                          </>
                      }
                    </div>

                    {/* Linked opportunities */}
                    <div className={styles.panelSection}>
                      <div className={styles.panelSectionTitle}>Linked opportunities</div>
                      {linkedOpps.length === 0
                        ? <p className="text-sm text-muted">No linked opportunities.</p>
                        : linkedOpps.map((o) => (
                          <div key={o[C_CN]} className={styles.linkedOppRow}>
                            <div>
                              <div className={styles.linkedOppTitle}>{o[C_TITLE]}</div>
                              <div className={styles.linkedOppMeta}>{o[C_CN]} · {o[C_PHASE]}</div>
                            </div>
                          </div>
                        ))
                      }
                    </div>

                    {/* Footer actions */}
                    <div className={styles.panelActions}>
                      <button className="btn btn-primary" onClick={startEdit}>Edit contact</button>
                      <button className="btn btn-ghost"
                        style={{ color: 'var(--red-600)' }}
                        onClick={() => setConfirmDelete(true)}>Delete</button>
                    </div>
                  </>
                ) : (
                  <>
                    {/* Edit mode */}
                    {contactFormFields()}

                    {/* Link opportunities in edit mode */}
                    <div className={styles.panelSection}>
                      <div className={styles.panelSectionTitle}>Linked opportunities</div>
                      {linkedOpps.map((o) => (
                        <div key={o[C_CN]} className={styles.linkedOppRow}>
                          <div style={{ flex: 1 }}>
                            <div className={styles.linkedOppTitle}>{o[C_TITLE]}</div>
                            <div className={styles.linkedOppMeta}>{o[C_CN]}</div>
                          </div>
                          <button
                            className="btn btn-ghost btn-icon"
                            title="Unlink"
                            onClick={() => handleUnlinkOpp(o)}
                            disabled={unlinkAction.isPending(o[C_CN])}
                          >{unlinkAction.isPending(o[C_CN]) ? '…' : '✕'}</button>
                        </div>
                      ))}
                      <div style={{ marginTop: 8 }}>
                        <input
                          className="form-input"
                          placeholder="Search opportunities to link…"
                          value={oppSearch}
                          onChange={(e) => setOppSearch(e.target.value)}
                          style={{ marginBottom: 6 }}
                        />
                        {oppSearch && (
                          <div className={styles.oppDropdown}>
                            {linkAction.isLoading
                              ? <div className={styles.oppDropdownEmpty}>Linking…</div>
                              : unlinkableOpps.length === 0
                                ? <div className={styles.oppDropdownEmpty}>No results</div>
                                : unlinkableOpps.map((o) => (
                                  <div key={o[C_CN]} className={styles.oppDropdownRow}
                                    onClick={() => handleLinkOpp(o)}>
                                    <div className={styles.linkedOppTitle}>{o[C_TITLE]}</div>
                                    <div className={styles.linkedOppMeta}>{o[C_CN]}</div>
                                  </div>
                                ))
                            }
                          </div>
                        )}
                      </div>
                    </div>

                    <div className={styles.panelActions}>
                      <button className="btn btn-primary" onClick={saveEdit} disabled={saving}>
                        {saving ? 'Saving…' : 'Save changes'}
                      </button>
                      <button className="btn" onClick={cancelEdit} disabled={saving}>Cancel</button>
                    </div>
                  </>
                )}
              </div>
            </div>
          </>
        )}
      </div>

      {/* Add contact modal */}
      {showAdd && (
        <Modal title="New contact" onClose={() => setShowAdd(false)}
          footer={
            <>
              <button className="btn" onClick={() => setShowAdd(false)}>Cancel</button>
              <button className="btn btn-primary" onClick={submitAdd} disabled={saving}>
                {saving ? 'Saving…' : 'Add contact'}
              </button>
            </>
          }
        >
          {contactFormFields()}
        </Modal>
      )}

      {/* Delete confirm modal */}
      {confirmDelete && (
        <Modal title="Delete contact" onClose={() => !deleteAction.isLoading && setConfirmDelete(null)}
          footer={
            <>
              <button className="btn" onClick={() => setConfirmDelete(null)} disabled={deleteAction.isLoading}>Cancel</button>
              <button className="btn btn-danger" onClick={handleDelete} disabled={deleteAction.isLoading}>
                {deleteAction.isLoading ? 'Deleting…' : 'Delete'}
              </button>
            </>
          }
        >
          <p className="text-sm">
            Delete <strong>{selected?.Name}</strong>? This cannot be undone.
          </p>
        </Modal>
      )}
    </>
  )
}
