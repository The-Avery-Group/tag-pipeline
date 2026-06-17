import { useState, useMemo, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { usePipeline } from '@/hooks/usePipeline'
import { useNotes } from '@/hooks/useNotes'
import { useTasks } from '@/hooks/useTasks'
import { useContacts } from '@/hooks/useContacts'
import { useAuth } from '@/auth/AuthContext'
import Topbar from '@/components/Layout/Topbar'
import AIPanel from '@/components/AI/AIPanel'
import Modal from '@/components/Common/Modal'
import { formatDate, isOverdue } from '@/utils/kpiHelpers'
import { buildEmailDraftContext, buildCapabilityStatementContext } from '@/services/groqService'
import { useValidationLists, pickList } from '@/hooks/useValidationLists'
import { OPPORTUNITY_PHASES, OPPORTUNITY_OUTLOOK, SET_ASIDE_VALUES, PRIORITY_VALUES, parsePOCNames, addContactToPOC, removeContactFromPOC } from '@/services/graphService'
import styles from './OpportunityDetail.module.css'

const C = {
  phase:          'TAG Opportunity Phase',
  actPhase:       'TAG Pipeline Activity Phase',
  contractNum:    'Contract Number / Notice ID',
  title:          'Project Title / Description*',
  agency:         'Agency*',
  department:     'Department*',
  office:         'Office*',
  value:          'Total Contract Value ($)*',
  baseValue:      'Base Year Value ($)*',
  assignedTo:     'Assigned To*',
  lastMod:        'Last Modified*',
  submDate:       'Submission Date (Response Date)*',
  solNum:         'Solicitation Number',
  naics:          'NAICS Code*',
  outlook:        'Opportunity Outlook',
  priority:       'Priority',
  setAside:       'Set- Aside*',
  poc:            'Contracting Officer / Specialist (POC)*',
  endDate:        'Contract End Date*',
  awardDate:      'Anticipated year for Award (MM/DD/YYYY)*',
  bidNoBid:       'Bid / No Bid?',
  partner:        'Partner',
  primeOrSub:     'Prime or Sub?',
  notes:          'Notes*',
  govwin:         'GovWin Link*',
  folder:         'Link to Folder',
  slideDeck:      'Link to Slide Deck',
  otherLinks:     'Other Links*',
  incumbent:      'Incumbent (Company Name)',
  fiscalYear:     'Fiscal Year',
  vehicle:        'Contract Vehicle',
  classification: 'Contract Classification*',
}

// Ensure external links always have a protocol so they don't resolve as relative paths
function safeUrl(url) {
  if (!url) return '#'
  const s = String(url).trim()
  if (s.startsWith('http://') || s.startsWith('https://') || s.startsWith('//')) return s
  return `https://${s}`
}

const PHASE_BADGE = {  'Identified':       'badge-tracking',
  'Research':         'badge-qualify',
  'Qualified':        'badge-qualify',
  'Proposal':         'badge-proposal',
  'Pending Award':    'badge-negotiation',
  'Contract Awarded': 'badge-award',
  'Cancelled':        'badge-closed-lost',
}

const STATUS_CYCLE = { 'To Do': 'In Progress', 'In Progress': 'Done', 'Done': 'To Do' }
const statusClass  = (s) => s === 'To Do' ? 'todo' : s === 'In Progress' ? 'progress' : 'done'

export default function OpportunityDetail({ toast }) {
  const { contractNumber } = useParams()
  const decodedCN = decodeURIComponent(contractNumber)
  const navigate = useNavigate()
  const { user } = useAuth()

  const { pipeline, loading: pipelineLoading, update: updateOpp } = usePipeline()
  const { notes, loading: notesLoading, add: addNote } = useNotes(decodedCN)
  const { tasks, add: addTask, update: updateTask, refreshContext } = useTasks(decodedCN)
  const { contacts } = useContacts()
  const { lists } = useValidationLists()

  const phaseOptions    = pickList(lists, 'TAG Opportunity Phase', OPPORTUNITY_PHASES)
  const outlookOptions  = pickList(lists, 'Opportunity Outlook', OPPORTUNITY_OUTLOOK)
  const priorityOptions = pickList(lists, 'Priority', PRIORITY_VALUES)
  const setAsideOptions = pickList(lists, 'Set-Aside', SET_ASIDE_VALUES)
  const primeOrSubOptions = pickList(lists, 'Prime or Sub', ['Prime', 'Sub'])
  const bidNoBidOptions   = pickList(lists, 'Bid / No Bid?', ['Bid', 'No Bid', 'TBD'])

  // ── ALL useState / useMemo / useCallback MUST be here, before any early return ──
  const [form, setForm]             = useState(null)
  const [editing, setEditing]       = useState(false)
  const [saving, setSaving]         = useState(false)
  const [newNote, setNewNote]       = useState('')
  const [addingNote, setAddingNote] = useState(false)
  const [showAddTask, setShowAddTask] = useState(false)
  const [savingTask, setSavingTask] = useState(false)
  const [updatingTaskId, setUpdatingTaskId] = useState(null)
  const [taskForm, setTaskForm]     = useState({
    Title: '', Description: '', AssignedTo: '', DueDate: '', Priority: 'Medium',
  })
  const [contactSearch, setContactSearch] = useState('')
  const [linkingContact, setLinkingContact] = useState(false)

  const opp = useMemo(
    () => pipeline.find((o) => o[C.contractNum] === decodedCN),
    [pipeline, decodedCN]
  )

  // Contacts linked via POC column (comma-separated names)
  const linkedContacts = useMemo(() => {
    if (!opp) return []
    const names = parsePOCNames(opp[C.poc])
    return names.map((name) => contacts.find((c) => c.Name === name)).filter(Boolean)
  }, [opp, contacts])

  // Contacts NOT yet linked — for search/add
  const unlinkedContacts = useMemo(() => {
    const linked = new Set(linkedContacts.map((c) => c.Name))
    const q = contactSearch.trim().toLowerCase()
    if (!q) return []
    return contacts.filter((c) => {
      if (linked.has(c.Name)) return false
      return [c.Name, c.Agency, c.Email].some((v) => v?.toLowerCase().includes(q))
    }).slice(0, 20)
  }, [contacts, linkedContacts, contactSearch])

  const contact = useMemo(
    () => contacts.find((c) => c.Notes?.includes(decodedCN)),
    [contacts, decodedCN]
  )

  const recentNotesStr = notes.slice(0, 3).map((n) => n.NoteText).join(' | ')

  const emailPrompt = useCallback(
    () => buildEmailDraftContext(opp ?? {}, contact, recentNotesStr),
    [opp, notes, contact, decodedCN]
  )

  const capPrompt = useCallback(
    () => buildCapabilityStatementContext(opp ?? {}, recentNotesStr),
    [opp, notes, decodedCN]
  )

  // ── Early returns AFTER all hooks ──
  if (pipelineLoading) {
    return (
      <div className="page-body">
        <div className="skeleton" style={{ height: 40, marginBottom: 12, width: 160 }} />
        <div className="skeleton" style={{ height: 28, marginBottom: 20, width: '60%' }} />
        <div className="card">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="skeleton" style={{ height: 36, marginBottom: 10 }} />
          ))}
        </div>
      </div>
    )
  }

  if (!opp) {
    return (
      <div className="page-body">
        <button className="btn btn-ghost" onClick={() => navigate('/opportunities')}>← Back</button>
        <p className="text-muted mt-3">Opportunity not found.</p>
      </div>
    )
  }

  // ── Handlers (plain functions, not hooks — fine below early returns) ──
  const cur = form || opp

  const handleEdit   = () => { setForm({ ...opp }); setEditing(true) }
  const handleCancel = () => { setForm(null); setEditing(false) }

  const handleSave = async () => {
    setSaving(true)
    try {
      await updateOpp(opp._rowIndex, form, opp)
      toast?.success('Saved')
      setEditing(false)
      setForm(null)
    } catch (err) {
      toast?.error(`Save failed: ${err.message}`)
    } finally {
      setSaving(false)
    }
  }

  const handleAddNote = async () => {
    if (!newNote.trim()) return
    setAddingNote(true)
    try {
      await addNote(user.firstName, newNote.trim())
      setNewNote('')
      toast?.success('Note added')
    } catch (err) {
      toast?.error(`Failed to add note: ${err.message}`)
    } finally {
      setAddingNote(false)
    }
  }

  const handleTaskStatusChange = async (task, newStatus) => {
    setUpdatingTaskId(task.TaskID)
    try {
      await updateTask(task._rowIndex, { Status: newStatus })
    } catch (err) {
      toast?.error(`Failed: ${err.message}`)
    } finally {
      setUpdatingTaskId(null)
    }
  }

  const handleLinkContact = async (contact) => {
    if (linkingContact) return
    setLinkingContact(true)
    try {
      await addContactToPOC(opp._rowIndex, opp[C.poc], contact.Name)
      setContactSearch('')
      toast?.success(`${contact.Name} linked`)
    } catch (err) {
      toast?.error(`Failed: ${err.message}`)
    } finally {
      setLinkingContact(false)
    }
  }

  const handleUnlinkContact = async (contact) => {
    try {
      await removeContactFromPOC(opp._rowIndex, opp[C.poc], contact.Name)
      toast?.success(`${contact.Name} unlinked`)
    } catch (err) {
      toast?.error(`Failed: ${err.message}`)
    }
  }

  const submitTask = async () => {
    setSavingTask(true)
    try {
      await addTask({
        ContractNumber: decodedCN,
        ContractTitle:  opp[C.title],
        ...taskForm,
        DueDate: taskForm.DueDate || '',
      }, user.displayName)
      setShowAddTask(false)
      setTaskForm({ Title: '', Description: '', AssignedTo: '', DueDate: '', Priority: 'Medium' })
      toast?.success('Task added')
    } catch (err) {
      toast?.error(`Failed to add task: ${err.message}`)
    } finally {
      setSavingTask(false)
    }
  }

  const field = (label, key, type = 'text', options = null, raw = false) => (
    <div className="form-field" key={key}>
      <label className="form-label">{label}</label>
      {editing
        ? options
          ? (
            <select className="form-input" value={cur[key] || ''}
              onChange={(e) => setForm({ ...form, [key]: e.target.value })}>
              {options.map((o) => <option key={o}>{o}</option>)}
            </select>
          ) : (
            <input className="form-input" type={type} value={cur[key] || ''}
              onChange={(e) => setForm({ ...form, [key]: e.target.value })} />
          )
        : <div className="form-input" style={{ background: 'var(--gray-50)' }}>
            {raw
              ? (cur[key] === null || cur[key] === undefined || cur[key] === '' ? '—' : String(cur[key]))
              : formatFieldValue(cur[key])}
          </div>
      }
    </div>
  )

  return (
    <>
      <Topbar
        title={opp[C.title]}
        subtitle1={decodedCN}
        subtitle2={opp[C.assignedTo] ? `Assigned: ${opp[C.assignedTo]}` : 'Unassigned'}
        showFilter={false}
        showNew={false}
      />
      <div className="page-body">
        <button className="btn btn-ghost text-sm" style={{ marginBottom: 14 }}
          onClick={() => navigate('/opportunities')}>
          ← Opportunities
        </button>

        <div className={styles.headerRow}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <span className={`badge ${PHASE_BADGE[opp[C.phase]] || 'badge-tracking'}`}>{opp[C.phase]}</span>
            {opp[C.outlook] && <span className="badge badge-tracking">{opp[C.outlook]}</span>}
            {opp[C.priority] && (
              <span className={`badge ${opp[C.priority] === 'Hot' ? 'badge-high' : opp[C.priority] === 'Warm' ? 'badge-medium' : 'badge-low'}`}>
                {opp[C.priority]}
              </span>
            )}
          </div>
          {!editing
            ? <button className="btn" onClick={handleEdit}>Edit</button>
            : (
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn btn-ghost" onClick={handleCancel} disabled={saving}>Cancel</button>
                <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
                  {saving ? 'Saving…' : 'Save'}
                </button>
              </div>
            )
          }
        </div>

        <div className={`card ${styles.fieldGrid}`}>
          {field('Total Contract Value ($)', C.value)}
          {field('TAG Opportunity Phase',    C.phase,    'text', phaseOptions)}
          {field('Opportunity Outlook',      C.outlook,  'text', outlookOptions)}
          {field('Priority',                 C.priority, 'text', priorityOptions)}
          {field('Department',               C.department)}
          {field('Agency',                   C.agency)}
          {field('Office',                   C.office)}
          {field('Solicitation Number',      C.solNum)}
          {field('NAICS Code',               C.naics,    'text', null, true)}
          {field('Set-Aside',                C.setAside, 'text', setAsideOptions)}
          {field('Submission / Response Date', C.submDate, 'date')}
          {field('Contract End Date',        C.endDate,  'date')}
          {field('Anticipated Award Date',   C.awardDate,'date')}
          {field('Assigned To',              C.assignedTo)}
          {field('Incumbent',                C.incumbent)}
          {field('Partner',                  C.partner)}
          {field('Prime or Sub?',            C.primeOrSub, 'text', primeOrSubOptions)}
          {field('Bid / No Bid?',            C.bidNoBid, 'text', bidNoBidOptions)}
          {field('POC / Contracting Officer',C.poc)}
        </div>

        <div className="card" style={{ marginBottom: 14 }}>
          <div className={styles.sectionTitle}>Links</div>
          {editing
            ? (
              <div className={styles.fieldGrid}>
                {field('GovWin Link',     C.govwin)}
                {field('Link to Folder',  C.folder)}
                {field('Link to Slide Deck', C.slideDeck)}
                {field('Other Links',     C.otherLinks)}
              </div>
            )
            : (
              [
                [C.govwin,     'GovWin ↗'],
                [C.folder,     '📁 Folder ↗'],
                [C.slideDeck,  '📊 Slide Deck ↗'],
                [C.otherLinks, '🔗 Other Link ↗'],
              ].some(([key]) => cur[key])
                ? (
                  <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                    {[
                      [C.govwin,     'GovWin ↗'],
                      [C.folder,     '📁 Folder ↗'],
                      [C.slideDeck,  '📊 Slide Deck ↗'],
                      [C.otherLinks, '🔗 Other Link ↗'],
                    ].map(([key, label]) => cur[key] && (
                      <a key={key} href={safeUrl(cur[key])} target="_blank" rel="noreferrer" className="btn text-sm">{label}</a>
                    ))}
                  </div>
                )
                : <p className="text-sm text-muted">No links added.</p>
            )
          }
        </div>

        <div className={styles.twoCol}>
          {/* Notes */}
          <div>
            <div className={styles.sectionTitle}>Notes</div>
            <div className="card">
              {notesLoading
                ? <div className="skeleton" style={{ height: 60 }} />
                : notes.length === 0
                  ? <p className="text-muted text-sm">No notes yet.</p>
                  : notes.map((n) => (
                      <div key={n.NoteID} className={styles.noteItem}>
                        <div className={styles.noteMeta}>{n.Date} · {n.Author}</div>
                        <div className={styles.noteText}>{n.NoteText}</div>
                      </div>
                    ))
              }
              <div className={styles.noteAdd}>
                <textarea className="form-input" placeholder="Add a note…"
                  value={newNote} onChange={(e) => setNewNote(e.target.value)} rows={2} />
                <button className="btn btn-primary text-sm" onClick={handleAddNote}
                  disabled={addingNote || !newNote.trim()}>
                  {addingNote ? 'Adding…' : 'Add note'}
                </button>
              </div>
            </div>
          </div>

          {/* Tasks + Contact */}
          <div>
            <div className={styles.sectionTitle}>Tasks</div>
            <div className="card" style={{ marginBottom: 12 }}>
              {tasks.length === 0
                ? <p className="text-muted text-sm">No tasks for this opportunity.</p>
                : tasks.map((t) => {
                    const over = isOverdue(t.DueDate) && t.Status !== 'Done'
                    return (
                      <div key={t.TaskID} className={styles.taskRow}>
                        <div style={{ flex: 1 }}>
                          <div className={styles.taskTitle}>{t.Title}</div>
                          <div className={styles.taskMeta}>
                            <span className={`badge badge-${t.Priority?.toLowerCase()}`}>{t.Priority}</span>
                            <span className={over ? 'text-danger text-xs' : 'text-muted text-xs'}>
                              {formatDate(t.DueDate)}{over ? ' · overdue' : ''}
                            </span>
                          </div>
                          {t.OpportunityNotes && (
                            <button className={styles.refreshCtx} onClick={() => refreshContext(t)}>
                              ↺ Refresh context
                            </button>
                          )}
                        </div>
                        <button
                          className={`badge badge-${statusClass(t.Status)}`}
                          style={{ cursor: updatingTaskId === t.TaskID ? 'default' : 'pointer', border: 'none', opacity: updatingTaskId === t.TaskID ? 0.6 : 1 }}
                          onClick={() => handleTaskStatusChange(t, STATUS_CYCLE[t.Status] || 'To Do')}
                          disabled={updatingTaskId === t.TaskID}
                          title="Click to advance status"
                        >
                          {updatingTaskId === t.TaskID ? 'Updating…' : t.Status}
                        </button>
                      </div>
                    )
                  })
              }
              <button className="btn text-sm w-full" style={{ marginTop: 8, justifyContent: 'center' }}
                onClick={() => setShowAddTask(true)}>
                + Add task
              </button>
            </div>

            {/* ── Contacts / POC ── */}
            <div className={styles.sectionTitle}>Contacts</div>
            {linkedContacts.length > 0 && linkedContacts.map((c) => (
              <div key={c.ContactID} className={`card ${styles.contactCard}`}
                style={{ marginBottom: 6 }}>
                <div className={styles.contactAv}>
                  {c.Name?.split(' ').map((n) => n[0]).slice(0, 2).join('')}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 500, fontSize: 13 }}>{c.Name}</div>
                  <div className="text-sm" style={{ color: 'var(--gray-400)', marginTop: 2 }}>
                    {c.Email
                      ? <a href={`mailto:${c.Email}`} className="text-sm">{c.Email}</a>
                      : c.Title || '—'}
                  </div>
                </div>
                {editing && (
                  <button className="btn btn-ghost btn-icon"
                    title="Unlink contact"
                    onClick={() => handleUnlinkContact(c)}>✕</button>
                )}
              </div>
            ))}
            {linkedContacts.length === 0 && (
              <p className="text-sm text-muted" style={{ marginBottom: 8 }}>
                No contacts linked.
              </p>
            )}
            {/* Add contact search — always visible */}
            <div style={{ position: 'relative' }}>
              <input
                className="form-input"
                placeholder="Search contacts to link…"
                value={contactSearch}
                onChange={(e) => setContactSearch(e.target.value)}
              />
              {contactSearch && (
                <div style={{
                  position: 'absolute', top: '100%', left: 0, right: 0,
                  background: '#fff', border: '0.5px solid var(--gray-200)',
                  borderRadius: 'var(--radius-md)', boxShadow: '0 4px 12px rgba(0,0,0,0.08)',
                  maxHeight: 180, overflowY: 'auto', zIndex: 10, marginTop: 4,
                }}>
                  {unlinkedContacts.length === 0
                    ? <div style={{ padding: '10px 12px', fontSize: 12, color: 'var(--gray-400)' }}>
                        No contacts found.
                      </div>
                    : unlinkedContacts.map((c) => (
                      <div key={c.ContactID}
                        onClick={() => !linkingContact && handleLinkContact(c)}
                        style={{
                          padding: '8px 12px', cursor: 'pointer',
                          borderBottom: '0.5px solid var(--gray-100)',
                          transition: 'background 0.1s',
                        }}
                        onMouseEnter={(e) => e.currentTarget.style.background = 'var(--blue-50)'}
                        onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                      >
                        <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--gray-900)' }}>
                          {c.Name}
                        </div>
                        <div style={{ fontSize: 11, color: 'var(--gray-400)', marginTop: 2 }}>
                          {c.Agency || c.Email || '—'}
                        </div>
                      </div>
                    ))
                  }
                </div>
              )}
            </div>
          </div>
        </div>

        <AIPanel title="Draft follow-up email"        buildPrompt={emailPrompt} defaultCollapsed />
        <AIPanel title="Generate capability statement" buildPrompt={capPrompt}   defaultCollapsed />
      </div>

      {showAddTask && (
        <Modal title="Add task" onClose={() => !savingTask && setShowAddTask(false)}
          footer={
            <>
              <button className="btn" onClick={() => setShowAddTask(false)} disabled={savingTask}>Cancel</button>
              <button className="btn btn-primary" onClick={submitTask} disabled={savingTask}>
                {savingTask ? 'Adding…' : 'Add task'}
              </button>
            </>
          }
        >
          <form onSubmit={(e) => { e.preventDefault(); submitTask() }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div className="form-field">
                <label className="form-label">Title *</label>
                <input className="form-input" required value={taskForm.Title}
                  onChange={(e) => setTaskForm({ ...taskForm, Title: e.target.value })} />
              </div>
              <div className="form-field">
                <label className="form-label">Description</label>
                <textarea className="form-input" rows={3} value={taskForm.Description}
                  onChange={(e) => setTaskForm({ ...taskForm, Description: e.target.value })} />
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div className="form-field">
                  <label className="form-label">Assigned to</label>
                  <input className="form-input" value={taskForm.AssignedTo}
                    onChange={(e) => setTaskForm({ ...taskForm, AssignedTo: e.target.value })} />
                </div>
                <div className="form-field">
                  <label className="form-label">Due date</label>
                  <input className="form-input" type="date" value={taskForm.DueDate}
                    onChange={(e) => setTaskForm({ ...taskForm, DueDate: e.target.value })} />
                </div>
                <div className="form-field">
                  <label className="form-label">Priority</label>
                  <select className="form-input" value={taskForm.Priority}
                    onChange={(e) => setTaskForm({ ...taskForm, Priority: e.target.value })}>
                    <option>Low</option><option>Medium</option><option>High</option>
                  </select>
                </div>
              </div>
            </div>
          </form>
        </Modal>
      )}
    </>
  )
}

function formatFieldValue(val) {
  if (val === null || val === undefined || val === '') return '—'
  if (val instanceof Date) return formatDate(val)
  if (typeof val === 'number') return val.toLocaleString()
  return String(val)
}
