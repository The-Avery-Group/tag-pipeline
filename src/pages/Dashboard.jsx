import { useMemo, useCallback, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '@/auth/AuthContext'
import { usePipeline } from '@/hooks/usePipeline'
import { useTasks } from '@/hooks/useTasks'
import Topbar from '@/components/Layout/Topbar'
import AIPanel from '@/components/AI/AIPanel'
import { computeKPIs, getGreeting, formatDate, isOverdue, getPhaseOrder } from '@/utils/kpiHelpers'
import { buildPipelineSummaryPrompt } from '@/services/groqService'
import styles from './Dashboard.module.css'

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

function formatCurrency(value) {
  if (!value || isNaN(value)) return '$0'
  if (value >= 1_000_000_000) return `$${(value / 1_000_000_000).toFixed(2)}B`
  if (value >= 1_000_000)     return `$${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000)         return `$${(value / 1_000).toFixed(0)}K`
  return `$${value.toFixed(0)}`
}

// Simple SVG pie chart
function PieChart({ data }) {
  const total = Object.values(data).reduce((s, v) => s + v, 0)
  if (!total) return <p className="text-muted text-sm">No data</p>

  const entries = Object.entries(data).filter(([, v]) => v > 0)
  let cumAngle = -Math.PI / 2

  const slices = entries.map(([label, value]) => {
    const frac = value / total
    const startAngle = cumAngle
    const endAngle = cumAngle + frac * 2 * Math.PI
    cumAngle = endAngle

    const R = 80, cx = 100, cy = 100
    const x1 = cx + R * Math.cos(startAngle)
    const y1 = cy + R * Math.sin(startAngle)
    const x2 = cx + R * Math.cos(endAngle)
    const y2 = cy + R * Math.sin(endAngle)
    const largeArc = frac > 0.5 ? 1 : 0
    const d = `M${cx},${cy} L${x1},${y1} A${R},${R} 0 ${largeArc},1 ${x2},${y2} Z`
    const midAngle = startAngle + (endAngle - startAngle) / 2
    const lx = cx + 55 * Math.cos(midAngle)
    const ly = cy + 55 * Math.sin(midAngle)

    return { label, value, frac, d, lx, ly, color: PHASE_COLORS[label] || '#85B7EB' }
  })

  return (
    <div className={styles.pieWrap}>
      <svg viewBox="0 0 200 200" width="160" height="160" style={{ flexShrink: 0 }}>
        {slices.map((s) => (
          <path key={s.label} d={s.d} fill={s.color} stroke="#fff" strokeWidth="1.5" />
        ))}
        {slices.map((s) =>
          s.frac > 0.08 ? (
            <text key={s.label + 'txt'} x={s.lx} y={s.ly}
              textAnchor="middle" dominantBaseline="middle"
              fontSize="12" fontWeight="600" fill="#333">
              {s.value}
            </text>
          ) : null
        )}
      </svg>
      <div className={styles.pieLegend}>
        {slices.map((s) => (
          <div key={s.label} className={styles.legendItem}>
            <span className={styles.legendDot} style={{ background: s.color }} />
            <span className="text-sm">{s.label}</span>
            <span className="text-xs text-muted">({Math.round(s.frac * 100)}%)</span>
          </div>
        ))}
      </div>
    </div>
  )
}

export default function Dashboard() {
  const { user } = useAuth()
  const navigate = useNavigate()
  const { pipeline, loading: pLoading } = usePipeline()
  const { tasks, loading: tLoading, update: updateTask } = useTasks()
  const [closingTask, setClosingTask] = useState(null)

  const kpis = useMemo(() => computeKPIs(pipeline, tasks), [pipeline, tasks])

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

  const handleCloseTask = async (task) => {
    setClosingTask(task.TaskID)
    try {
      await updateTask(task._rowIndex, { Status: 'Done' })
    } finally {
      setClosingTask(null)
    }
  }

  const today = new Date()
  const dateStr = today.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })

  const phaseBadgeClass = (phase) => {
    if (phase === 'Research')         return 'badge-qualify'
    if (phase === 'Indentified')      return 'badge-proposal'
    if (phase === 'Contract Awarded') return 'badge-award'
    return 'badge-tracking'
  }

  // Parse pipeline total value correctly
  const totalValue = useMemo(() => {
    const sum = pipeline.reduce((acc, o) => {
      const n = parseFloat(String(o[C.value] || '0').replace(/[^0-9.]/g, ''))
      return acc + (isNaN(n) ? 0 : n)
    }, 0)
    return formatCurrency(sum)
  }, [pipeline])

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
        greetingLarge
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
            <div className={styles.kpiValue}>{pLoading ? '—' : totalValue}</div>
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
          {/* Pie chart */}
          <div className="card">
            <div className={styles.cardTitle}>Opportunities by phase</div>
            {pLoading
              ? <div className={`skeleton ${styles.chartSkeleton}`} />
              : <PieChart data={kpis.byPhase} />
            }
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
                    <div className={styles.oppVal}>
                      {formatCurrency(parseFloat(String(opp[C.value] || '0').replace(/[^0-9.]/g, '')) || 0)}
                    </div>
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
                  const isClosing = closingTask === task.TaskID
                  return (
                    <div key={task.TaskID} className={styles.taskRow}>
                      <button
                        className={`${styles.taskCheck} ${task.Status === 'Done' ? styles.taskCheckDone : ''}`}
                        onClick={() => handleCloseTask(task)}
                        disabled={isClosing}
                        title="Mark as done"
                        aria-label="Mark task done"
                      >
                        {isClosing ? '…' : task.Status === 'Done' ? '✓' : ''}
                      </button>
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