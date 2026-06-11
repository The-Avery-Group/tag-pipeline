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
import { buildEmailDraftPrompt, buildCapabilityStatementPrompt } from '@/services/groqService'
import { OPPORTUNITY_PHASES, OPPORTUNITY_OUTLOOK, SET_ASIDE_VALUES, PRIORITY_VALUES } from '@/services/graphService'
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
  incumbent:      'Incumbent (Company Name)',
  fiscalYear:     'Fiscal Year',
  vehicle:        'Contract Vehicle',
  classification: 'Contract Classification*',
}

const PHASE_BADGE = {
  'Research':         'badge-qualify',
  'Indentified':      'badge-proposal',
  'Contract Awarded': 'badge-award',
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

  // ── ALL useState / useMemo / useCallback MUST be here, before any early return ──
  const [form, setForm]             = useState(null)
  const [editing, setEditing]       = useState(false)
  const [saving, setSaving]         = useState(false)
  const [newNote, setNewNote]       = useState('')
  const [addingNote, setAddingNote] = useState(false)
  const [showAddTask, setShowAddTask] = useState(false)
  const [taskForm, setTaskForm]     = useState({
    Title: '', Description: '', AssignedTo: '', DueDate: '', Priority: 'Medium',
  })

  const opp = useMemo(
    () => pipeline.find((o) => o[C.contractNum] === decodedCN),
    [pipeline, decodedCN]
  )

  const contact = useMemo(
    () => contacts.find((c) => c.Notes?.includes(decodedCN)),
    [contacts, decodedCN]
  )

  // These must be unconditional — they cannot move below the early returns
  const emailPrompt = useCallback(
    () => buildEmailDraftPrompt({
      ContractTitle: opp?.[C.title] ?? '',
      Agency:        opp?.[C.agency] ?? '',
      Phase:         opp?.[C.phase] ?? '',
      ContractNumber: decodedCN,
      recentNotes: notes.slice(0, 3).map((n) => n.NoteText).join(' | '),
    }, contact),
    [opp, notes, contact, decodedCN]
  )

  const capPrompt = useCallback(
    () => buildCapabilityStatementPrompt({
      ContractTitle:     opp?.[C.title] ?? '',
      Agency:            opp?.[C.agency] ?? '',
      NAICS:             opp?.[C.naics] ?? '',
      ContractNumber:    decodedCN,
      SolicitationNumber: opp?.[C.solNum] ?? '',
      recentNotes: notes.slice(0, 3).map((n) => n.NoteText).join(' | '),
    }),
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
    try {
      await updateTask(task._rowIndex, { Status: newStatus })
    } catch (err) {
      toast?.error(`Failed: ${err.message}`)
    }
  }

  const submitTask = async () => {
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
    }
  }

  const field = (label, key, type = 'text', options = null) => (
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
        : <div className="form-input" style={{ background: 'var(--gray-50)' }}>{formatFieldValue(cur[key])}</div>
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
        showNew={editing}
        newLabel={saving ? 'Saving…' : 'Save changes'}
        onNew={handleSave}
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
            : <button className="btn btn-ghost" onClick={handleCancel}>Cancel</button>
          }
        </div>

        <div className={`card ${styles.fieldGrid}`}>
          {field('Total Contract Value ($)', C.value)}
          {field('TAG Opportunity Phase',    C.phase,    'text', OPPORTUNITY_PHASES)}
          {field('Opportunity Outlook',      C.outlook,  'text', OPPORTUNITY_OUTLOOK)}
          {field('Priority',                 C.priority, 'text', PRIORITY_VALUES)}
          {field('Department',               C.department)}
          {field('Agency',                   C.agency)}
          {field('Office',                   C.office)}
          {field('Solicitation Number',      C.solNum)}
          {field('NAICS Code',               C.naics)}
          {field('Set-Aside',                C.setAside, 'text', SET_ASIDE_VALUES)}
          {field('Submission / Response Date', C.submDate, 'date')}
          {field('Contract End Date',        C.endDate,  'date')}
          {field('Anticipated Award Date',   C.awardDate,'date')}
          {field('Assigned To',              C.assignedTo)}
          {field('Incumbent',                C.incumbent)}
          {field('Partner',                  C.partner)}
          {field('Prime or Sub?',            C.primeOrSub, 'text', ['Prime', 'Sub'])}
          {field('POC / Contracting Officer',C.poc)}
        </div>

        {(opp[C.govwin] || opp[C.folder]) && (
          <div className="card" style={{ marginBottom: 14, display: 'flex', gap: 12 }}>
            {opp[C.govwin] && <a href={opp[C.govwin]} target="_blank" rel="noreferrer" className="btn text-sm">GovWin ↗</a>}
            {opp[C.folder] && <a href={opp[C.folder]} target="_blank" rel="noreferrer" className="btn text-sm">📁 Folder ↗</a>}
          </div>
        )}

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
                          style={{ cursor: 'pointer', border: 'none' }}
                          onClick={() => handleTaskStatusChange(t, STATUS_CYCLE[t.Status] || 'To Do')}
                          title="Click to advance status"
                        >
                          {t.Status}
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

            {contact && (
              <>
                <div className={styles.sectionTitle}>Contact</div>
                <div className={`card ${styles.contactCard}`}>
                  <div className={styles.contactAv}>
                    {contact.Name?.split(' ').map((n) => n[0]).slice(0, 2).join('')}
                  </div>
                  <div>
                    <div style={{ fontWeight: 500, fontSize: 13 }}>{contact.Name}</div>
                    <div className="text-muted text-sm">{contact.Title} · {contact.Organization}</div>
                    <a href={`mailto:${contact.Email}`} className="text-sm">{contact.Email}</a>
                  </div>
                </div>
              </>
            )}

            {!contact && opp[C.poc] && (
              <>
                <div className={styles.sectionTitle}>Contracting Officer</div>
                <div className="card">
                  <div style={{ fontSize: 13, fontWeight: 500 }}>{opp[C.poc]}</div>
                  {opp[C.poc].includes('@') && (
                    <a href={`mailto:${opp[C.poc]}`} className="text-sm">{opp[C.poc]}</a>
                  )}
                </div>
              </>
            )}
          </div>
        </div>

        <AIPanel title="Draft follow-up email"        buildPrompt={emailPrompt} defaultCollapsed />
        <AIPanel title="Generate capability statement" buildPrompt={capPrompt}   defaultCollapsed />
      </div>

      {showAddTask && (
        <Modal title="Add task" onClose={() => setShowAddTask(false)}
          footer={
            <>
              <button className="btn" onClick={() => setShowAddTask(false)}>Cancel</button>
              <button className="btn btn-primary" onClick={submitTask}>Add task</button>
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