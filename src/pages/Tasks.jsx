import { useState, useMemo, useRef, useEffect, useCallback } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useAuth } from '@/auth/AuthContext'
import { useTasks } from '@/hooks/useTasks'
import { usePipeline } from '@/hooks/usePipeline'
import { useValidationLists, pickList } from '@/hooks/useValidationLists'
import { ASSIGNEE_VALUES } from '@/services/graphService'
import { useScrollRestoration } from '@/hooks/useScrollRestoration'
import Topbar from '@/components/Layout/Topbar'
import Modal from '@/components/Common/Modal'
import { formatDate, isOverdue } from '@/utils/kpiHelpers'
import { buildSearchIndex, filterSearchIndex } from '@/utils/searchHelpers'
import styles from './Tasks.module.css'

const STATUSES  = ['All', 'Overdue', 'To Do', 'In Progress', 'Done']
const PRIORITIES = ['All', 'High', 'Medium', 'Low']
const GROUPS    = ['None', 'Contract', 'Assignee', 'Priority']
const SORTS     = ['Due Date', 'Priority', 'Assignee', 'Status']
const PRIORITY_RANK = { High: 3, Medium: 2, Low: 1 }
const STATUS_NEXT = { 'To Do': 'In Progress', 'In Progress': 'Done', 'Done': 'To Do' }

const BLANK_FORM = {
  ContractNumber: '', Title: '', Description: '',
  AssignedTo: '', DueDate: '', Priority: 'Medium', Status: 'To Do',
}

// ── Priority dot colour ───────────────────────────────────────────────────
function PriorityDot({ priority }) {
  const color = priority === 'High' ? 'var(--red-600)'
    : priority === 'Medium' ? 'var(--amber-600)'
    : 'var(--gray-400)'
  return <span style={{ width: 7, height: 7, borderRadius: '50%', background: color, display: 'inline-block', flexShrink: 0 }} />
}

// ── Circle checkbox ───────────────────────────────────────────────────────
function CircleCheck({ status, onClick }) {
  const done = status === 'Done'
  return (
    <button
      className={`${styles.circle} ${done ? styles.circleDone : ''}`}
      onClick={(e) => { e.stopPropagation(); onClick() }}
      aria-label={done ? 'Mark incomplete' : 'Mark complete'}
      title={done ? 'Mark incomplete' : 'Mark complete'}
    >
      {done && (
        <svg width="11" height="9" viewBox="0 0 11 9" fill="none">
          <path d="M1 4L4 7.5L10 1" stroke="white" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      )}
    </button>
  )
}

// ── Detail panel (slides in from right) ──────────────────────────────────
function DetailPanel({ task, pipeline, onClose, onUpdate, onDelete, toast, assigneeOptions }) {
  const navigate = useNavigate()
  const [form, setForm] = useState({ ...task })
  const [saving, setSaving] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const ref = useRef(null)

  // Close on Escape
  useEffect(() => {
    const handler = (e) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onClose])

  // Close on backdrop click
  useEffect(() => {
    const handler = (e) => {
      if (ref.current && !ref.current.contains(e.target)) onClose()
    }
    // Small delay so the click that opened the panel doesn't immediately close it
    const t = setTimeout(() => document.addEventListener('mousedown', handler), 50)
    return () => { clearTimeout(t); document.removeEventListener('mousedown', handler) }
  }, [onClose])

  const setField = useCallback((field, val) => setForm((f) => ({ ...f, [field]: val })), [])

  const handleSave = async () => {
    setSaving(true)
    try {
      await onUpdate(task._rowIndex, form)
      toast?.success('Task updated')
      onClose()
    } catch (err) {
      toast?.error(`Failed: ${err.message}`)
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async () => {
    try {
      await onDelete(task._rowIndex)
      toast?.success('Task deleted')
      onClose()
    } catch (err) {
      toast?.error(`Failed: ${err.message}`)
    }
  }

  const over = isOverdue(task.DueDate) && task.Status !== 'Done'

  return (
    <div className={styles.panelBackdrop}>
      <div ref={ref} className={styles.panel}>
        {/* Panel header */}
        <div className={styles.panelHeader}>
          <CircleCheck status={form.Status} onClick={() => setField('Status', STATUS_NEXT[form.Status] || 'To Do')} />
          <input
            className={styles.panelTitle}
            value={form.Title}
            onChange={(e) => setField('Title', e.target.value)}
            placeholder="Task title"
          />
          <button className={styles.panelClose} onClick={onClose} aria-label="Close">✕</button>
        </div>

        <div className={styles.panelBody}>
          {/* Description */}
          <div className={styles.panelSection}>
            <label className={styles.panelLabel}>Notes</label>
            <textarea
              className={styles.panelTextarea}
              rows={4}
              placeholder="Add a note…"
              value={form.Description || ''}
              onChange={(e) => setField('Description', e.target.value)}
            />
          </div>

          {/* Fields grid */}
          <div className={styles.panelFields}>
            <div className={styles.panelField}>
              <label className={styles.panelLabel}>Status</label>
              <select className={styles.panelSelect} value={form.Status} onChange={(e) => setField('Status', e.target.value)}>
                <option>To Do</option>
                <option>In Progress</option>
                <option>Done</option>
              </select>
            </div>
            <div className={styles.panelField}>
              <label className={styles.panelLabel}>Priority</label>
              <select className={styles.panelSelect} value={form.Priority || ''} onChange={(e) => setField('Priority', e.target.value)}>
                <option>Low</option>
                <option>Medium</option>
                <option>High</option>
              </select>
            </div>
            <div className={styles.panelField}>
              <label className={styles.panelLabel}>Due date</label>
              <input
                className={styles.panelSelect}
                type="date"
                value={form.DueDate || ''}
                onChange={(e) => setField('DueDate', e.target.value)}
              />
            </div>
            <div className={styles.panelField}>
              <label className={styles.panelLabel}>Assigned to</label>
              <select
                className={styles.panelSelect}
                value={form.AssignedTo || ''}
                onChange={(e) => setField('AssignedTo', e.target.value)}
              >
                <option value="">— Select —</option>
                {assigneeOptions.map((a) => <option key={a}>{a}</option>)}
              </select>
            </div>
          </div>

          {/* Contract link */}
          {task.ContractNumber && (
            <div className={styles.panelSection}>
              <label className={styles.panelLabel}>Opportunity</label>
              <button
                type="button"
                className={styles.panelContractChip}
                style={{ cursor: 'pointer', textAlign: 'left', width: '100%', font: 'inherit' }}
                onClick={() => navigate(`/opportunities/${encodeURIComponent(task.ContractNumber)}`)}
                title="Open this opportunity"
              >
                <span className={styles.panelContractNum}>{task.ContractNumber}</span>
                {task.ContractTitle && (
                  <span className={styles.panelContractTitle}>{task.ContractTitle}</span>
                )}
              </button>
            </div>
          )}

          {/* Metadata */}
          <div className={styles.panelMeta}>
            {task.CreatedDate && <span>Created {formatDate(task.CreatedDate)}</span>}
            {task.CreatedBy  && <span>by {task.CreatedBy}</span>}
          </div>
        </div>

        {/* Panel footer */}
        <div className={styles.panelFooter}>
          {!confirmDelete
            ? (
              <button
                className={styles.panelDeleteBtn}
                onClick={() => setConfirmDelete(true)}
              >
                🗑 Delete task
              </button>
            ) : (
              <div className={styles.panelDeleteConfirm}>
                <span className="text-xs text-muted">Are you sure?</span>
                <button className="btn btn-danger" style={{ padding: '4px 10px', fontSize: 12 }} onClick={handleDelete}>Delete</button>
                <button className="btn" style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => setConfirmDelete(false)}>Cancel</button>
              </div>
            )
          }
          <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Searchable opportunity picker ─────────────────────────────────────────
function OppPicker({ pipeline, value, onChange }) {
  const [search, setSearch] = useState('')
  const C_CN    = 'Contract Number / Notice ID'
  const C_TITLE = 'Project Title / Description*'

  const selected = pipeline.find((o) => o[C_CN] === value)

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return pipeline.slice(0, 50) // cap unfiltered list for perf
    return pipeline.filter((o) =>
      [o[C_CN], o[C_TITLE]].some((v) => v && String(v).toLowerCase().includes(q))
    ).slice(0, 50)
  }, [pipeline, search])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {/* Search input */}
      <input
        className="form-input"
        placeholder="Search by contract # or title…"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        autoComplete="off"
      />
      {/* Scrollable results list */}
      <div style={{
        border: '0.5px solid var(--gray-200)',
        borderRadius: 'var(--radius-md)',
        maxHeight: 200,
        overflowY: 'auto',
        background: 'var(--surface)',
      }}>
        {filtered.length === 0
          ? (
            <div style={{ padding: '10px 12px', fontSize: 12, color: 'var(--gray-400)' }}>
              No opportunities match your search.
            </div>
          )
          : filtered.map((o) => {
              const cn = o[C_CN]
              const t  = o[C_TITLE]
              const isSelected = cn === value
              return (
                <div
                  key={`${cn}-${o._rowIndex}`}
                  onClick={() => { onChange(cn); setSearch('') }}
                  style={{
                    padding: '8px 12px',
                    cursor: 'pointer',
                    borderBottom: '0.5px solid var(--gray-100)',
                    background: isSelected ? 'var(--blue-50)' : 'transparent',
                    transition: 'background 0.1s',
                  }}
                  onMouseEnter={(e) => { if (!isSelected) e.currentTarget.style.background = 'var(--gray-50)' }}
                  onMouseLeave={(e) => { if (!isSelected) e.currentTarget.style.background = 'transparent' }}
                >
                  <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--blue-800)', marginBottom: 2 }}>
                    {cn || '—'}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--gray-900)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {t || '—'}
                  </div>
                </div>
              )
            })
        }
      </div>
      {/* Selected value summary */}
      {selected && (
        <div style={{ fontSize: 11, color: 'var(--gray-400)', paddingLeft: 2 }}>
          Selected: <strong style={{ color: 'var(--blue-800)' }}>{selected[C_CN]}</strong> — {selected[C_TITLE]}
        </div>
      )}
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────
export default function Tasks({ toast }) {
  const navigate = useNavigate()
  const { user } = useAuth()
  const { tasks, loading, add, update, remove } = useTasks()
  const { pipeline } = usePipeline()
  const { lists } = useValidationLists()
  const assigneeOptions = pickList(lists, 'Assignee', ASSIGNEE_VALUES)
  const listPaneRef = useRef(null)
  useScrollRestoration(listPaneRef)   // Tasks uses its own scroll container (.listPane), not the page-level one

  // Read ?status=overdue once on initial load only (e.g. arriving from the
  // Dashboard's Overdue Tasks KPI) — not kept in sync with the URL on an
  // ongoing basis, unlike Opportunities.jsx's full filter persistence.
  const [searchParams, setSearchParams] = useSearchParams()
  const [statusFilter, setStatusFilter] = useState(() => {
    const s = searchParams.get('status')
    return s === 'overdue' ? 'Overdue' : 'All'
  })
  const [priorityFilter, setPriorityFilter] = useState('All')
  const [hideDone, setHideDone]             = useState(true)
  const [search, setSearch]                 = useState('')
  const [groupBy, setGroupBy]           = useState('None')
  const [sortBy, setSortBy]             = useState(() => localStorage.getItem('tasks_sort_by') || 'Due Date')
  const [sortDir, setSortDir]           = useState(() => localStorage.getItem('tasks_sort_dir') || 'asc')
  const [showAdd, setShowAdd]           = useState(false)
  const [selected, setSelected]         = useState(null)   // task open in detail panel

  // Arriving from the Dashboard's task list with ?taskId=... — open that
  // task's detail panel automatically once it's available, THEN clear the
  // param immediately. Without this, closing the panel sets `selected` back
  // to null, which re-runs this effect — and since `taskId` was still
  // sitting in the URL, it would immediately reopen the same task, making
  // the panel impossible to close (and its full-viewport backdrop then
  // silently blocks every other click on the page, including sidebar nav).
  useEffect(() => {
    const taskId = searchParams.get('taskId')
    if (!taskId || selected) return
    const match = tasks.find((t) => t.TaskID === taskId)
    if (match) {
      setSelected(match)
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev)
        next.delete('taskId')
        return next
      }, { replace: true })
    }
  }, [searchParams, tasks, selected])
  const [taskForm, setTaskForm]         = useState(BLANK_FORM)
  const [creatingTask, setCreatingTask] = useState(false)
  const creatingTaskRef                 = useRef(false)
  const setFormField = useCallback((f, v) => setTaskForm((p) => ({ ...p, [f]: v })), [])

  // Persist sort preference across sessions
  useEffect(() => { localStorage.setItem('tasks_sort_by', sortBy) }, [sortBy])
  useEffect(() => { localStorage.setItem('tasks_sort_dir', sortDir) }, [sortDir])

  const taskSearchIndex = useMemo(() => buildSearchIndex(tasks), [tasks])
  const tasksMatchingSearch = useMemo(
    () => new Set(filterSearchIndex(taskSearchIndex, search)),
    [taskSearchIndex, search]
  )

  const filtered = useMemo(() => {
    let rows = statusFilter === 'All'
      ? tasks
      : statusFilter === 'Overdue'
        ? tasks.filter((t) => t.Status !== 'Done' && isOverdue(t.DueDate))
        : tasks.filter((t) => t.Status === statusFilter)
    if (priorityFilter !== 'All') rows = rows.filter((t) => t.Priority === priorityFilter)
    if (hideDone) rows = rows.filter((t) => t.Status !== 'Done')
    if (search.trim()) rows = rows.filter((task) => tasksMatchingSearch.has(task))
    return [...rows].sort((a, b) => {
      let cmp = 0
      if (sortBy === 'Due Date') {
        // Default sort keeps overdue tasks pinned first regardless of direction —
        // direction only controls ordering within the overdue/not-overdue groups
        const aOver = isOverdue(a.DueDate) && a.Status !== 'Done'
        const bOver = isOverdue(b.DueDate) && b.Status !== 'Done'
        if (aOver !== bOver) return aOver ? -1 : 1
        cmp = new Date((a.DueDate || '9999') + 'T00:00:00') - new Date((b.DueDate || '9999') + 'T00:00:00')
      } else if (sortBy === 'Priority') {
        cmp = (PRIORITY_RANK[a.Priority] || 0) - (PRIORITY_RANK[b.Priority] || 0)
      } else if (sortBy === 'Assignee') {
        cmp = String(a.AssignedTo || '').localeCompare(String(b.AssignedTo || ''))
      } else if (sortBy === 'Status') {
        cmp = String(a.Status || '').localeCompare(String(b.Status || ''))
      }
      return sortDir === 'asc' ? cmp : -cmp
    })
  }, [tasks, statusFilter, priorityFilter, hideDone, search, sortBy, sortDir, tasksMatchingSearch])

  const grouped = useMemo(() => {
    if (groupBy === 'None') return { '': filtered }
    const key = groupBy === 'Contract' ? 'ContractNumber' : groupBy === 'Assignee' ? 'AssignedTo' : 'Priority'
    return filtered.reduce((acc, t) => {
      const k = t[key] || 'Unassigned'
      acc[k] = acc[k] || []
      acc[k].push(t)
      return acc
    }, {})
  }, [filtered, groupBy])

  const handleStatusCycle = async (task) => {
    try {
      await update(task._rowIndex, { Status: STATUS_NEXT[task.Status] || 'To Do' })
    } catch (err) {
      toast?.error(`Failed: ${err.message}`)
    }
  }

  const submitTask = async () => {
    if (creatingTaskRef.current) return
    if (!taskForm.Title.trim()) {
      toast?.error('Enter a task title')
      return
    }

    creatingTaskRef.current = true
    setCreatingTask(true)
    const opp = pipeline.find((o) => o['Contract Number / Notice ID'] === taskForm.ContractNumber)
    try {
      await add({
        ...taskForm,
        ContractTitle: opp?.['Project Title / Description*'] || taskForm.ContractNumber,
      }, user.displayName)
      toast?.success('Task added')
      setShowAdd(false)
      setTaskForm(BLANK_FORM)
    } catch (err) {
      toast?.error(`Failed: ${err.message}`)
    } finally {
      creatingTaskRef.current = false
      setCreatingTask(false)
    }
  }

  const openCount    = filtered.filter((t) => t.Status !== 'Done').length
  const overdueCount = filtered.filter((t) => isOverdue(t.DueDate) && t.Status !== 'Done').length

  return (
    <>
      <Topbar
        title="Tasks"
        subtitle1={`${openCount} open`}
        subtitle2={overdueCount > 0 ? `${overdueCount} overdue` : undefined}
        showFilter={false}
        showNew={true}
        newLabel="New task"
        onNew={() => setShowAdd(true)}
      />

      <div className={styles.layout}>
        {/* Left: list */}
        <div ref={listPaneRef} className={styles.listPane}>
          <div className={styles.taskSearch}>
            <input
              className="form-input"
              placeholder="Search all task fields…"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              aria-label="Search all task fields"
            />
            {search && <button type="button" className="btn btn-ghost btn-icon" onClick={() => setSearch('')} aria-label="Clear task search">✕</button>}
          </div>
          {/* Filter + group bar */}
          <div className={styles.controls}>
            <div className={styles.controlsRow}>
              <div className={styles.controlClusters}>
              <div className={styles.controlGroup}>
                <span className={styles.controlLabel}>Status</span>
                <div className="filter-chips">
                  {STATUSES.map((s) => (
                    <button key={s} className={`filter-chip ${statusFilter === s ? 'active' : ''}`}
                      onClick={() => setStatusFilter(s)}>
                      {s}
                    </button>
                  ))}
                </div>
              </div>
              <div className={styles.controlGroup}>
                <span className={styles.controlLabel}>Priority</span>
                <div className="filter-chips">
                  {PRIORITIES.map((p) => (
                    <button key={p} className={`filter-chip ${priorityFilter === p ? 'active' : ''}`}
                      onClick={() => setPriorityFilter(p)}>
                      {p}
                    </button>
                  ))}
                </div>
              </div>
              <div className={styles.controlGroup}>
                <span className={styles.controlLabel}>Group</span>
                <select className={styles.controlSelect} value={groupBy} onChange={(e) => setGroupBy(e.target.value)} aria-label="Group tasks by">
                  {GROUPS.map((group) => <option key={group} value={group}>{group}</option>)}
                </select>
              </div>
              <div className={styles.controlGroup}>
                <span className={styles.controlLabel}>Sort</span>
                <select className={styles.controlSelect} value={sortBy} onChange={(e) => setSortBy(e.target.value)} aria-label="Sort tasks by">
                  {SORTS.map((sort) => <option key={sort} value={sort}>{sort}</option>)}
                </select>
                <button
                  className="btn btn-ghost btn-icon text-xs"
                  onClick={() => setSortDir((d) => d === 'asc' ? 'desc' : 'asc')}
                  title={sortDir === 'asc' ? 'Ascending, click for descending' : 'Descending, click for ascending'}
                  aria-label="Toggle sort direction"
                >
                  {sortDir === 'asc' ? '↑' : '↓'}
                </button>
              </div>
              </div>
              <button
                className={`filter-chip ${hideDone ? '' : 'active'}`}
                onClick={() => setHideDone((value) => !value)}
              >
                {hideDone ? 'Show completed' : 'Hide completed'}
              </button>
            </div>
          </div>

          {loading ? (
            <div className={styles.skeletonList}>
              {[1,2,3,4,5].map((i) => (
                <div key={i} className={styles.skeletonRow}>
                  <div className="skeleton" style={{ width: 22, height: 22, borderRadius: '50%', flexShrink: 0 }} />
                  <div style={{ flex: 1 }}>
                    <div className="skeleton" style={{ height: 14, width: '60%', marginBottom: 6 }} />
                    <div className="skeleton" style={{ height: 11, width: '35%' }} />
                  </div>
                </div>
              ))}
            </div>
          ) : filtered.length === 0 ? (
            <div className={styles.empty}>
              <div className={styles.emptyIcon}>☑</div>
              <div className={styles.emptyText}>No tasks here</div>
              <div className={styles.emptySub}>Add a task to get started</div>
            </div>
          ) : (
            Object.entries(grouped).map(([groupName, groupTasks]) => (
              <div key={groupName} className={styles.group}>
                {groupBy !== 'None' && groupName && (
                  <div className={styles.groupHeader}>
                    <span>{groupName}</span>
                    <span className={styles.groupCount}>{groupTasks.length}</span>
                  </div>
                )}
                {groupTasks.map((task) => {
                  const over     = isOverdue(task.DueDate) && task.Status !== 'Done'
                  const isActive = selected?.TaskID === task.TaskID
                  return (
                    <div
                      key={`${task.TaskID}-${task._rowIndex}`}
                      className={`${styles.taskRow} ${isActive ? styles.taskRowActive : ''}`}
                      onClick={() => setSelected(task)}
                    >
                      <CircleCheck
                        status={task.Status}
                        onClick={() => handleStatusCycle(task)}
                      />
                      <div className={styles.taskBody}>
                        <div className={`${styles.taskTitle} ${task.Status === 'Done' ? styles.taskDone : ''}`}>
                          {task.Title}
                        </div>
                        <div className={styles.taskMeta}>
                          {task.ContractNumber && (
                            <span className={styles.metaChip}>{task.ContractNumber}</span>
                          )}
                          <PriorityDot priority={task.Priority} />
                          <span className={styles.metaText}>{task.Priority}</span>
                          {task.DueDate && (
                            <>
                              <span className={styles.metaDot}>·</span>
                              <span className={over ? styles.metaOverdue : styles.metaDate}>
                                {over ? '⚠ ' : ''}{formatDate(task.DueDate)}
                              </span>
                            </>
                          )}
                          {task.AssignedTo && (
                            <>
                              <span className={styles.metaDot}>·</span>
                              <span className={styles.metaText}>{task.AssignedTo}</span>
                            </>
                          )}
                        </div>
                      </div>
                      <span className={`${styles.statusPill} ${styles['pill_' + (task.Status === 'To Do' ? 'todo' : task.Status === 'In Progress' ? 'progress' : 'done')]}`}>
                        {task.Status}
                      </span>
                    </div>
                  )
                })}
              </div>
            ))
          )}
        </div>

        {/* Right: detail panel */}
        {selected && (
          <DetailPanel
            key={selected.TaskID}
            task={selected}
            pipeline={pipeline}
            onClose={() => setSelected(null)}
            onUpdate={update}
            onDelete={remove}
            toast={toast}
            assigneeOptions={assigneeOptions}
          />
        )}
      </div>

      {/* Add task modal */}
      {showAdd && (
        <Modal
          title="New task"
          onClose={() => !creatingTask && setShowAdd(false)}
          footer={
            <>
              <button className="btn" onClick={() => setShowAdd(false)} disabled={creatingTask}>Cancel</button>
              <button className="btn btn-primary" onClick={submitTask} disabled={creatingTask} aria-busy={creatingTask}>
                {creatingTask ? 'Creating…' : 'Add task'}
              </button>
            </>
          }
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div className="form-field">
              <label className="form-label">Opportunity *</label>
              <OppPicker
                pipeline={pipeline}
                value={taskForm.ContractNumber}
                onChange={(cn) => setFormField('ContractNumber', cn)}
              />
            </div>
            <div className="form-field">
              <label className="form-label">Title *</label>
              <input className="form-input" required value={taskForm.Title}
                onChange={(e) => setFormField('Title', e.target.value)} />
            </div>
            <div className="form-field">
              <label className="form-label">Notes</label>
              <textarea className="form-input" rows={3} value={taskForm.Description}
                onChange={(e) => setFormField('Description', e.target.value)} />
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div className="form-field">
                <label className="form-label">Assigned to</label>
                <select className="form-input" value={taskForm.AssignedTo}
                  onChange={(e) => setFormField('AssignedTo', e.target.value)}>
                  <option value="">— Select —</option>
                  {assigneeOptions.map((a) => <option key={a}>{a}</option>)}
                </select>
              </div>
              <div className="form-field">
                <label className="form-label">Due date</label>
                <input className="form-input" type="date" value={taskForm.DueDate}
                  onChange={(e) => setFormField('DueDate', e.target.value)} />
              </div>
              <div className="form-field">
                <label className="form-label">Priority</label>
                <select className="form-input" value={taskForm.Priority}
                  onChange={(e) => setFormField('Priority', e.target.value)}>
                  <option>Low</option><option>Medium</option><option>High</option>
                </select>
              </div>
            </div>
          </div>
        </Modal>
      )}
    </>
  )
}
