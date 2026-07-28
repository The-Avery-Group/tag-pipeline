import OpportunitySection from '@/components/Opportunity/OpportunitySection'
import { formatDate, isOverdue } from '@/utils/kpiHelpers'
import styles from '@/pages/OpportunityDetail.module.css'

const STATUS_CYCLE = { 'To Do': 'In Progress', 'In Progress': 'Done', 'Done': 'To Do' }
const statusClass = (status) => status === 'To Do' ? 'todo' : status === 'In Progress' ? 'progress' : 'done'

export default function OpportunityTasksSection({
  tasks,
  hideDoneTasks,
  setHideDoneTasks,
  updatingTaskId,
  updateTaskStatus,
  refreshContext,
  addTask,
}) {
  const visibleTasks = tasks.filter((task) => !hideDoneTasks || task.Status !== 'Done')

  return (
    <OpportunitySection title="Tasks">
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8 }}>
        <button
          type="button"
          className={`filter-chip ${hideDoneTasks ? 'active' : ''}`}
          onClick={() => setHideDoneTasks((value) => !value)}
        >
          Hide completed
        </button>
      </div>
      {visibleTasks.length === 0
        ? <p className="text-muted text-sm" style={{ marginBottom: 8 }}>No tasks for this opportunity.</p>
        : visibleTasks.map((task) => {
            const overdue = isOverdue(task.DueDate) && task.Status !== 'Done'
            return (
              <div key={task.TaskID} className={styles.taskRow}>
                <div style={{ flex: 1 }}>
                  <div className={styles.taskTitle}>{task.Title}</div>
                  <div className={styles.taskMeta}>
                    <span className={`badge badge-${task.Priority?.toLowerCase()}`}>{task.Priority}</span>
                    <span className={overdue ? 'text-danger text-xs' : 'text-muted text-xs'}>
                      {formatDate(task.DueDate)}{overdue ? ' · overdue' : ''}
                    </span>
                  </div>
                  {task.OpportunityNotes && (
                    <button className={styles.refreshCtx} onClick={() => refreshContext(task)}>
                      ↺ Refresh context
                    </button>
                  )}
                </div>
                <button
                  className={`badge badge-${statusClass(task.Status)}`}
                  style={{
                    cursor: updatingTaskId === task.TaskID ? 'default' : 'pointer',
                    border: 'none',
                    opacity: updatingTaskId === task.TaskID ? 0.6 : 1,
                  }}
                  onClick={() => updateTaskStatus(task, STATUS_CYCLE[task.Status] || 'To Do')}
                  disabled={updatingTaskId === task.TaskID}
                  title="Click to advance status"
                >
                  {updatingTaskId === task.TaskID ? 'Updating…' : task.Status}
                </button>
              </div>
            )
          })
      }
      <button className="btn text-sm w-full" style={{ marginTop: 8, justifyContent: 'center' }}
        onClick={addTask}>
        + Add task
      </button>
    </OpportunitySection>
  )
}
