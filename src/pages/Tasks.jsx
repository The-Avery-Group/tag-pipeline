import { useState, useMemo, useRef, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '@/auth/AuthContext'
import { useTasks } from '@/hooks/useTasks'
import { usePipeline } from '@/hooks/usePipeline'
import Topbar from '@/components/Layout/Topbar'
import Modal from '@/components/Common/Modal'
import { formatDate, isOverdue } from '@/utils/kpiHelpers'
import styles from './Tasks.module.css'

const STATUSES  = ['All', 'To Do', 'In Progress', 'Done']
const GROUPS    = ['None', 'Contract', 'Assignee', 'Priority']
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
function DetailPanel({ task, pipeline, onClose, onUpdate, onDelete, toast }) {
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
              <input
                className={styles.panelSelect}
                value={form.AssignedTo || ''}
                onChange={(e) => setField('AssignedTo', e.target.value)}
                placeholder="—"
              />
            </div>
          </div>

          {/* Contract link */}
          {task.ContractNumber && (
            <div className={styles.panelSection}>
              <label className={styles.panelLabel}>Opportunity</label>
              <div className={styles.panelContractChip}>
                <span className={styles.panelContractNum}>{task.ContractNumber}</span>
                {task.ContractTitle && (
                  <span className={styles.panelContractTitle}>{task.ContractTitle}</span>
                )}
              </div>
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

// ── Main component ────────────────────────────────────────────────────────
export default function Tasks({ toast }) {
  const navigate = useNavigate()
  const { user } = useAuth()
  const { tasks, loading, add, update, remove } = useTasks()
  const { pipeline } = usePipeline()

  const [statusFilter, setStatusFilter] = useState('All')
  const [groupBy, setGroupBy]           = useState('None')
  const [showAdd, setShowAdd]           = useState(false)
  const [selected, setSelected]         = useState(null)   // task open in detail panel
  const [taskForm, setTaskForm]         = useState(BLANK_FORM)
  const setFormField = useCallback((f, v) => setTaskForm((p) => ({ ...p, [f]: v })), [])

  const filtered = useMemo(() => {
    const rows = statusFilter === 'All' ? tasks : tasks.filter((t) => t.Status === statusFilter)
    return [...rows].sort((a, b) => {
      const aOver = isOverdue(a.DueDate) && a.Status !== 'Done'
      const bOver = isOverdue(b.DueDate) && b.Status !== 'Done'
      if (aOver !== bOver) return aOver ? -1 : 1
      return new Date((a.DueDate || '9999') + 'T00:00:00') - new Date((b.DueDate || '9999') + 'T00:00:00')
    })
  }, [tasks, statusFilter])

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
        <div className={styles.listPane}>
          {/* Filter + group bar */}
          <div className={styles.controls}>
            <div className="filter-chips">
              {STATUSES.map((s) => (
                <button key={s} className={`filter-chip ${statusFilter === s ? 'active' : ''}`}
                  onClick={() => setStatusFilter(s)}>
                  {s}
                </button>
              ))}
            </div>
            <div className={styles.groupRow}>
              <span className="text-xs text-muted">Group by</span>
              {GROUPS.map((g) => (
                <button key={g} className={`filter-chip ${groupBy === g ? 'active' : ''}`}
                  onClick={() => setGroupBy(g)}>
                  {g}
                </button>
              ))}
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
          />
        )}
      </div>

      {/* Add task modal */}
      {showAdd && (
        <Modal
          title="New task"
          onClose={() => setShowAdd(false)}
          footer={
            <>
              <button className="btn" onClick={() => setShowAdd(false)}>Cancel</button>
              <button className="btn btn-primary" onClick={submitTask}>Add task</button>
            </>
          }
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div className="form-field">
              <label className="form-label">Opportunity *</label>
              <select className="form-input" required value={taskForm.ContractNumber}
                onChange={(e) => setFormField('ContractNumber', e.target.value)}>
                <option value="">Select opportunity…</option>
                {pipeline.map((o) => {
                  const cn = o['Contract Number / Notice ID']
                  const t  = o['Project Title / Description*']
                  return <option key={`${cn}-${o._rowIndex}`} value={cn}>{cn} — {t}</option>
                })}
              </select>
              {taskForm.ContractNumber && (() => {
                const opp = pipeline.find(o => o['Contract Number / Notice ID'] === taskForm.ContractNumber)
                return opp ? (
                  <div style={{ marginTop: 4, fontSize: 11, color: 'var(--gray-400)', paddingLeft: 2 }}>
                    {opp['Project Title / Description*']}
                  </div>
                ) : null
              })()}
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
                <input className="form-input" value={taskForm.AssignedTo}
                  onChange={(e) => setFormField('AssignedTo', e.target.value)} />
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
