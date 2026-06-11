import { useMemo, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '@/auth/AuthContext'
import { usePipeline } from '@/hooks/usePipeline'
import { useTasks } from '@/hooks/useTasks'
import Topbar from '@/components/Layout/Topbar'
import AIPanel from '@/components/AI/AIPanel'
import { computeKPIs, getGreeting, formatDate, isOverdue, getPhaseOrder } from '@/utils/kpiHelpers'
import { buildPipelineSummaryPrompt } from '@/services/groqService'
import styles from './Dashboard.module.css'

// Real column names from Pipeline sheet
const C = {
  phase:       'TAG Opportunity Phase',
  title:       'Project Title / Description*',
  contractNum: 'Contract Number / Notice ID',
  value:       'Total Contract Value ($)*',
  assignedTo:  'Assigned To*',
  lastMod:     'Last Modified*',
  submDate:    'Submission Date (Response Date)*',
  priority:    'Priority',
}

const PHASE_COLORS = {
  'Research':          '#FAC775',
  'Indentified':       '#85B7EB',
  'Contract Awarded':  '#9FE1CB',
}

export default function Dashboard() {
  const { user } = useAuth()
  const navigate = useNavigate()
  const { pipeline, loading: pLoading } = usePipeline()
  const { tasks, loading: tLoading } = useTasks()

  const kpis = useMemo(() => computeKPIs(pipeline, tasks), [pipeline, tasks])

  const phaseMax = useMemo(
    () => Math.max(...Object.values(kpis.byPhase), 1),
    [kpis.byPhase]
  )

  const recentOpps = useMemo(
    () => [...pipeline]
      .sort((a, b) => new Date(b[C.lastMod] || 0) - new Date(a[C.lastMod] || 0))
      .slice(0, 6),
    [pipeline]
  )

  const openTasks = useMemo(
    () => tasks.filter((t) => t.Status !== 'Done').slice(0, 5),
    [tasks]
  )

  const aiPrompt = useCallback(
    () => buildPipelineSummaryPrompt({
      total: kpis.total,
      totalValue: kpis.totalValueFormatted,
      open: kpis.open,
      closed: kpis.closed,
      byPhase: kpis.byPhase,
      overdueTasks: kpis.overdueCount,
      topOwner: kpis.topOwner,
    }),
    [kpis]
  )

  const today = new Date()
  const dateStr = today.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })

  // Phase badge mapping for real phase names
  const phaseBadgeClass = (phase) => {
    if (phase === 'Research')         return 'badge-qualify'
    if (phase === 'Indentified')      return 'badge-proposal'
    if (phase === 'Contract Awarded') return 'badge-award'
    return 'badge-tracking'
  }

  return (
    <>
      <Topbar
        title={user ? getGreeting(user.firstName) : 'Dashboard'}
        subtitle1={dateStr}
        subtitle2={`${kpis.open} active opportunities`}
        showFilter={false}
        showNew={true}
        newLabel="New opportunity"
        onNew={() => navigate('/opportunities?new=1')}
      />
      <div className="page-body">
        <AIPanel
          title="AI pipeline summary"
          buildPrompt={aiPrompt}
          defaultCollapsed={true}
        />

        {/* KPI cards */}
        <div className={styles.kpiGrid}>
          <div className={styles.kpiCard}>
            <div className={styles.kpiLabel}>Total opportunities</div>
            <div className={styles.kpiValue}>{pLoading ? '—' : kpis.total}</div>
            <div className={styles.kpiDelta}>{kpis.open} open</div>
          </div>
          <div className={styles.kpiCard}>
            <div className={styles.kpiLabel}>Pipeline value</div>
            <div className={styles.kpiValue}>{pLoading ? '—' : kpis.totalValueFormatted}</div>
            <div className={styles.kpiDelta}>Active opportunities</div>
          </div>
          <div className={styles.kpiCard}>
            <div className={styles.kpiLabel}>Open / Awarded</div>
            <div className={styles.kpiValue}>
              {pLoading ? '—' : kpis.open}
              <span className={styles.kpiSub}> / {kpis.closed}</span>
            </div>
            <div className={styles.kpiDelta}>{kpis.closed} awarded YTD</div>
          </div>
          <div className={styles.kpiCard}>
            <div className={styles.kpiLabel}>Overdue tasks</div>
            <div className={`${styles.kpiValue} ${kpis.overdueCount > 0 ? styles.kpiDanger : ''}`}>
              {tLoading ? '—' : kpis.overdueCount}
            </div>
            <div className={`${styles.kpiDelta} ${kpis.overdueCount > 0 ? styles.kpiDeltaDanger : ''}`}>
              {kpis.overdueCount > 0 ? 'Needs attention' : 'All on track'}
            </div>
          </div>
        </div>

        <div className={styles.twoCol}>
          {/* Phase chart */}
          <div className="card">
            <div className={styles.cardTitle}>Opportunities by phase</div>
            {pLoading
              ? <div className={`skeleton ${styles.chartSkeleton}`} />
              : getPhaseOrder().map((phase) => {
                  const count = kpis.byPhase[phase] || 0
                  if (!count) return null
                  const pct = Math.round((count / phaseMax) * 100)
                  return (
                    <div key={phase} className={styles.barRow}>
                      <div className={styles.barLabel}>{phase}</div>
                      <div className={styles.barTrack}>
                        <div
                          className={styles.barFill}
                          style={{ width: `${pct}%`, background: PHASE_COLORS[phase] || '#85B7EB' }}
                        />
                      </div>
                      <div className={styles.barCount}>{count}</div>
                    </div>
                  )
                })}
          </div>

          {/* Recent opps */}
          <div className="card">
            <div className={styles.cardTitleRow}>
              <div className={styles.cardTitle}>Recent opportunities</div>
              <button className="btn btn-ghost text-sm" onClick={() => navigate('/opportunities')}>
                View all →
              </button>
            </div>
            {pLoading
              ? [1,2,3].map((i) => <div key={i} className={`skeleton ${styles.rowSkeleton}`} />)
              : recentOpps.map((opp) => (
                  <div
                    key={opp[C.contractNum]}
                    className={styles.oppRow}
                    onClick={() => navigate(`/opportunities/${encodeURIComponent(opp[C.contractNum])}`)}
                  >
                    <div className={styles.oppName}>{opp[C.title]}</div>
                    <span className={`badge ${phaseBadgeClass(opp[C.phase])}`}>
                      {opp[C.phase]}
                    </span>
                    <div className={styles.oppVal}>{formatCurrency(parseFloat(String(opp[C.value] || '0').replace(/[^0-9.]/g, '')) || 0)}</div>
                  </div>
                ))}
          </div>
        </div>

        {/* Open tasks */}
        <div className="card" style={{ marginTop: 12 }}>
          <div className={styles.cardTitleRow}>
            <div className={styles.cardTitle}>Open tasks</div>
            <button className="btn btn-ghost text-sm" onClick={() => navigate('/tasks')}>
              View all →
            </button>
          </div>
          {tLoading
            ? [1,2,3].map((i) => <div key={i} className={`skeleton ${styles.rowSkeleton}`} />)
            : openTasks.length === 0
              ? <p className="text-muted text-sm" style={{ padding: '8px 0' }}>No open tasks — nice work!</p>
              : openTasks.map((task) => {
                  const overdue = isOverdue(task.DueDate)
                  return (
                    <div key={task.TaskID} className={styles.taskRow}>
                      <div className={`${styles.taskCheck} ${task.Status === 'Done' ? styles.taskCheckDone : ''}`} />
                      <div style={{ flex: 1 }}>
                        <div className={styles.taskTitle}>{task.Title}</div>
                        <div className={styles.taskMeta}>
                          <span className={styles.taskContract}>{task.ContractNumber}</span>
                          <span className={`badge badge-${task.Priority?.toLowerCase()}`}>{task.Priority}</span>
                          <span className={overdue ? styles.dueDateOverdue : styles.dueDate}>
                            {overdue ? `Due ${formatDate(task.DueDate)} · overdue` : `Due ${formatDate(task.DueDate)}`}
                          </span>
                        </div>
                      </div>
                      <span className={styles.taskAssignee}>{task.AssignedTo}</span>
                    </div>
                  )
                })}
        </div>
      </div>
    </>
  )
}

function formatCurrency(value) {
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `$${(value / 1_000).toFixed(0)}K`
  return `$${value.toFixed(0)}`
}

