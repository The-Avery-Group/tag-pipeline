import { useState, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '@/auth/AuthContext'
import { useTasks } from '@/hooks/useTasks'
import { usePipeline } from '@/hooks/usePipeline'
import Topbar from '@/components/Layout/Topbar'
import Modal from '@/components/Common/Modal'
import { formatDate, isOverdue } from '@/utils/kpiHelpers'
import styles from './Tasks.module.css'

const STATUSES = ['All', 'To Do', 'In Progress', 'Done']
const GROUPS   = ['None', 'Contract', 'Assignee', 'Priority']

export default function Tasks({ toast }) {
  const navigate = useNavigate()
  const { user } = useAuth()
  const { tasks, loading, add, update } = useTasks()
  const { pipeline } = usePipeline()

  const [statusFilter, setStatusFilter] = useState('All')
  const [groupBy, setGroupBy] = useState('None')
  const [showAdd, setShowAdd] = useState(false)
  const [taskForm, setTaskForm] = useState({
    ContractNumber: '', Title: '', Description: '', AssignedTo: '',
    DueDate: '', Priority: 'Medium',
  })

  const filtered = useMemo(() => {
    let rows = statusFilter === 'All' ? tasks : tasks.filter((t) => t.Status === statusFilter)
    return rows.sort((a, b) => {
      // Overdue first, then by due date
      const aOver = isOverdue(a.DueDate) && a.Status !== 'Done'
      const bOver = isOverdue(b.DueDate) && b.Status !== 'Done'
      if (aOver !== bOver) return aOver ? -1 : 1
      return new Date(a.DueDate || '9999') - new Date(b.DueDate || '9999')
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
    const cycle = { 'To Do': 'In Progress', 'In Progress': 'Done', 'Done': 'To Do' }
    try {
      await update(task._rowIndex, { Status: cycle[task.Status] || 'To Do' })
    } catch (err) {
      toast?.error(`Failed to update status: ${err.message}`)
    }
  }

  const submitTask = async () => {
    const CN = 'Contract Number / Notice ID'
    const CT = 'Project Title / Description*'
    const opp = pipeline.find((o) => o[CN] === taskForm.ContractNumber)
    try {
      await add({
        ...taskForm,
        ContractTitle: opp?.[CT] || taskForm.ContractNumber,
      }, user.displayName)
      toast?.success('Task added')
      setShowAdd(false)
      setTaskForm({ ContractNumber: '', Title: '', Description: '', AssignedTo: '', DueDate: '', Priority: 'Medium' })
    } catch (err) {
      toast?.error(`Failed to add task: ${err.message}`)
    }
  }

  const handleAdd = (e) => { e.preventDefault(); submitTask() }

  const statusClass = (s) => s === 'To Do' ? 'todo' : s === 'In Progress' ? 'progress' : 'done'

  return (
    <>
      <Topbar
        title="Task manager"
        subtitle1={`${filtered.filter((t) => t.Status !== 'Done').length} open · ${filtered.filter((t) => isOverdue(t.DueDate) && t.Status !== 'Done').length} overdue`}
        showFilter={true}
        showNew={true}
        newLabel="New task"
        onNew={() => setShowAdd(true)}
      />
      <div className="page-body">
        <div className={styles.controls}>
          <div className="filter-chips">
            {STATUSES.map((s) => (
              <button key={s} className={`filter-chip ${statusFilter === s ? 'active' : ''}`} onClick={() => setStatusFilter(s)}>
                {s}
              </button>
            ))}
          </div>
          <div className={styles.groupRow}>
            <span className="text-xs text-muted">Group by:</span>
            {GROUPS.map((g) => (
              <button key={g} className={`filter-chip ${groupBy === g ? 'active' : ''}`} onClick={() => setGroupBy(g)}>
                {g}
              </button>
            ))}
          </div>
        </div>

        {loading
          ? <div className="card"><div className="skeleton" style={{ height: 200 }} /></div>
          : Object.entries(grouped).map(([groupName, groupTasks]) => (
              <div key={groupName} className="card" style={{ marginBottom: 10 }}>
                {groupBy !== 'None' && groupName && (
                  <div className={styles.groupHeader}>{groupName}</div>
                )}
                {groupTasks.length === 0
                  ? <p className="text-muted text-sm">No tasks in this group.</p>
                  : groupTasks.map((task) => {
                      const over = isOverdue(task.DueDate) && task.Status !== 'Done'
                      return (
                        <div key={task.TaskID} className={styles.taskRow}>
                          <div className={`${styles.checkbox} ${task.Status === 'Done' ? styles.cbDone : ''}`}
                            onClick={() => handleStatusCycle(task)}
                            role="checkbox"
                            aria-checked={task.Status === 'Done'}
                            tabIndex={0}
                            onKeyDown={(e) => e.key === 'Enter' && handleStatusCycle(task)}
                          >
                            {task.Status === 'Done' && <span aria-hidden="true">✓</span>}
                          </div>
                          <div style={{ flex: 1 }}>
                            <div className={`${styles.taskTitle} ${task.Status === 'Done' ? styles.taskDone : ''}`}>
                              {task.Title}
                            </div>
                            <div className={styles.taskMeta}>
                              <button
                                className={styles.contractLink}
                                onClick={() => navigate(`/opportunities/${task.ContractNumber}`)}
                              >
                                {task.ContractNumber}
                              </button>
                              <span className={`badge badge-${task.Priority?.toLowerCase()}`}>{task.Priority}</span>
                              <span className={over ? 'text-danger text-xs' : 'text-muted text-xs'}>
                                {formatDate(task.DueDate)}{over ? ' · overdue' : ''}
                              </span>
                            </div>
                          </div>
                          <button
                            className={`badge badge-${statusClass(task.Status)}`}
                            style={{ cursor: 'pointer', border: 'none' }}
                            onClick={() => handleStatusCycle(task)}
                            title="Click to advance status"
                          >
                            {task.Status}
                          </button>
                          <div className={styles.assignee}>{task.AssignedTo}</div>
                        </div>
                      )
                    })}
              </div>
            ))}
      </div>

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
          <form onSubmit={handleAdd}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div className="form-field">
                <label className="form-label">Opportunity (contract #) *</label>
                <select className="form-input" required value={taskForm.ContractNumber} onChange={(e) => setTaskForm({ ...taskForm, ContractNumber: e.target.value })}>
                  <option value="">Select opportunity…</option>
                  {pipeline.map((o) => {
                    const cn = o['Contract Number / Notice ID']
                    const t  = o['Project Title / Description*']
                    return (
                      <option key={cn} value={cn}>{cn} — {t}</option>
                    )
                  })}
                </select>
              </div>
              <div className="form-field">
                <label className="form-label">Title *</label>
                <input className="form-input" required value={taskForm.Title} onChange={(e) => setTaskForm({ ...taskForm, Title: e.target.value })} />
              </div>
              <div className="form-field">
                <label className="form-label">Description</label>
                <textarea className="form-input" rows={3} value={taskForm.Description} onChange={(e) => setTaskForm({ ...taskForm, Description: e.target.value })} />
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div className="form-field">
                  <label className="form-label">Assigned to</label>
                  <input className="form-input" value={taskForm.AssignedTo} onChange={(e) => setTaskForm({ ...taskForm, AssignedTo: e.target.value })} />
                </div>
                <div className="form-field">
                  <label className="form-label">Due date</label>
                  <input className="form-input" type="date" value={taskForm.DueDate} onChange={(e) => setTaskForm({ ...taskForm, DueDate: e.target.value })} />
                </div>
                <div className="form-field">
                  <label className="form-label">Priority</label>
                  <select className="form-input" value={taskForm.Priority} onChange={(e) => setTaskForm({ ...taskForm, Priority: e.target.value })}>
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
