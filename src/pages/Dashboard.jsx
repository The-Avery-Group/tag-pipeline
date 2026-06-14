import { useMemo, useCallback, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '@/auth/AuthContext'
import { usePipeline } from '@/hooks/usePipeline'
import { useTasks } from '@/hooks/useTasks'
import Topbar from '@/components/Layout/Topbar'
import AIPanel from '@/components/AI/AIPanel'
import { computeKPIs, getGreeting, formatDate, isOverdue, formatCurrency } from '@/utils/kpiHelpers'
import { buildPipelineSummaryPrompt } from '@/services/groqService'
import styles from './Dashboard.module.css'

const C = {
  phase:       'TAG Opportunity Phase',
  actPhase:    'TAG Pipeline Activity Phase',
  title:       'Project Title / Description*',
  contractNum: 'Contract Number / Notice ID',
  value:       'Total Contract Value ($)*',
  assignedTo:  'Assigned To*',
  lastMod:     'Last Modified*',
  submDate:    'Submission Date (Response Date)*',
  endDate:     'Contract End Date*',
  agency:      'Agency*',
  outlook:     'Opportunity Outlook',
  priority:    'Priority',
}

const PHASE_COLORS = {
  'Identified':       '#C7D9F5',
  'Research':         '#FAC775',
  'Qualified':        '#F59B42',
  'Proposal':         '#85B7EB',
  'Pending Award':    '#B39DDB',
  'Contract Awarded': '#9FE1CB',
  'Cancelled':        '#E0E0E0',
}

const PHASE_BADGE = {
  'Identified':       'badge-tracking',
  'Research':         'badge-qualify',
  'Qualified':        'badge-qualify',
  'Proposal':         'badge-proposal',
  'Pending Award':    'badge-negotiation',
  'Contract Awarded': 'badge-award',
  'Cancelled':        'badge-closed-lost',
}

// ── Sub-components ────────────────────────────────────────────────────────

function KpiCard({ label, value, sub, danger }) {
  return (
    <div className={styles.kpiCard}>
      <div className={styles.kpiLabel}>{label}</div>
      <div className={`${styles.kpiValue} ${danger ? styles.kpiDanger : ''}`}>{value}</div>
      {sub && <div className={`${styles.kpiDelta} ${danger ? styles.kpiDeltaDanger : ''}`}>{sub}</div>}
    </div>
  )
}

// Horizontal bar chart — pure SVG, no deps
function PhaseBarChart({ byPhase, byPhaseValue }) {
  const entries = Object.entries(byPhase).filter(([, v]) => v > 0)
  if (!entries.length) return <p className="text-sm text-muted">No data</p>

  const maxCount = Math.max(...entries.map(([, v]) => v))
  const BAR_MAX_W = 340
  const ROW_H = 32
  const LABEL_W = 120
  const COUNT_W = 32
  const svgH = entries.length * ROW_H + 8

  return (
    <svg viewBox={`0 0 ${LABEL_W + BAR_MAX_W + COUNT_W + 16} ${svgH}`}
      style={{ width: '100%', height: svgH }}>
      {entries.map(([phase, count], i) => {
        const barW = maxCount > 0 ? (count / maxCount) * BAR_MAX_W : 0
        const y = i * ROW_H
        const color = PHASE_COLORS[phase] || '#85B7EB'
        const val = byPhaseValue[phase] ? formatCurrency(byPhaseValue[phase]) : ''
        return (
          <g key={phase}>
            <text x={LABEL_W - 6} y={y + ROW_H / 2 + 1}
              textAnchor="end" dominantBaseline="middle"
              fontSize="11" fill="var(--gray-600)">{phase}</text>
            <rect x={LABEL_W} y={y + 6} width={Math.max(barW, 2)} height={ROW_H - 12}
              rx="3" fill={color} />
            <text x={LABEL_W + barW + 6} y={y + ROW_H / 2 + 1}
              dominantBaseline="middle" fontSize="11" fontWeight="600"
              fill="var(--gray-900)">{count}</text>
            {val && (
              <text x={LABEL_W + barW + COUNT_W + 10} y={y + ROW_H / 2 + 1}
                dominantBaseline="middle" fontSize="10"
                fill="var(--gray-400)">{val}</text>
            )}
          </g>
        )
      })}
    </svg>
  )
}

// Monday.com-style consistent row — invisible guardrails via fixed flex widths
function OppRow({ opp, onClick }) {
  const value = parseFloat(String(opp[C.value] || '0').replace(/[^0-9.]/g, ''))
  return (
    <div className={styles.consistentRow} onClick={onClick}>
      <span className={styles.colTitle}>{opp[C.title]}</span>
      <span className={styles.colPhase}>
        <span className={`badge ${PHASE_BADGE[opp[C.phase]] || 'badge-tracking'}`}>
          {opp[C.phase]}
        </span>
      </span>
      <span className={styles.colAgency}>{opp[C.agency] || '—'}</span>
      <span className={styles.colValue}>{value ? formatCurrency(value) : '—'}</span>
      <span className={styles.colAssignee}>{opp[C.assignedTo] || '—'}</span>
      <span className={`${styles.colDue} ${isOverdue(opp[C.submDate]) ? 'text-danger' : 'text-muted'}`}>
        {formatDate(opp[C.submDate])}
      </span>
    </div>
  )
}

function OppRowHeader() {
  return (
    <div className={`${styles.consistentRow} ${styles.consistentRowHeader}`}>
      <span className={styles.colTitle}>Title</span>
      <span className={styles.colPhase}>Phase</span>
      <span className={styles.colAgency}>Agency</span>
      <span className={styles.colValue}>Value</span>
      <span className={styles.colAssignee}>Assigned to</span>
      <span className={styles.colDue}>Due</span>
    </div>
  )
}

// Task row with same guardrail approach
function TaskRow({ task, onClose, closing }) {
  const overdue = isOverdue(task.DueDate)
  return (
    <div className={styles.consistentRow}>
      <span className={styles.colTaskTitle}>{task.Title}</span>
      <span className={styles.colTaskContract + ' text-muted'}>{task.ContractNumber}</span>
      <span className={styles.colTaskPriority}>
        {task.Priority && (
          <span className={`badge badge-${task.Priority === 'High' ? 'high' : task.Priority === 'Medium' ? 'medium' : 'low'}`}>
            {task.Priority}
          </span>
        )}
      </span>
      <span className={`${styles.colTaskDue} ${overdue ? 'text-danger' : 'text-muted'}`}>
        {overdue ? `${formatDate(task.DueDate)} · overdue` : formatDate(task.DueDate)}
      </span>
      <span className={styles.colTaskAssignee + ' text-muted'}>{task.AssignedTo || '—'}</span>
      <span className={styles.colTaskAction}>
        <button
          className={`${styles.taskCheck} ${task.Status === 'Done' ? styles.taskCheckDone : ''}`}
          onClick={() => onClose(task)}
          disabled={closing}
          title="Mark as done"
          aria-label="Mark task done"
        >
          {closing ? '…' : task.Status === 'Done' ? '✓' : ''}
        </button>
      </span>
    </div>
  )
}

function TaskRowHeader() {
  return (
    <div className={`${styles.consistentRow} ${styles.consistentRowHeader}`}>
      <span className={styles.colTaskTitle}>Task</span>
      <span className={styles.colTaskContract}>Contract</span>
      <span className={styles.colTaskPriority}>Priority</span>
      <span className={styles.colTaskDue}>Due</span>
      <span className={styles.colTaskAssignee}>Assignee</span>
      <span className={styles.colTaskAction} />
    </div>
  )
}

// Agency chip card
function AgencyChip({ name, count }) {
  return (
    <div className={styles.agencyChip}>
      <div className={styles.agencyCount}>{count}</div>
      <div className={styles.agencyName}>{name}</div>
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────

export default function Dashboard({ toast }) {
  const { user } = useAuth()
  const navigate = useNavigate()
  const { pipeline, loading: pLoading } = usePipeline()
  const { tasks, loading: tLoading, update: updateTask } = useTasks()
  const [closingTask, setClosingTask] = useState(null)
  const [taskTab, setTaskTab] = useState('overdue') // 'overdue' | 'active'

  const kpis = useMemo(() => computeKPIs(pipeline, tasks), [pipeline, tasks])

  const recentOpps = useMemo(
    () => [...pipeline]
      .sort((a, b) => {
        const da = new Date(b[C.lastMod] || 0)
        const db = new Date(a[C.lastMod] || 0)
        return da - db
      })
      .slice(0, 8),
    [pipeline]
  )

  const overdueTasks = useMemo(
    () => tasks.filter((t) => t.Status !== 'Done' && isOverdue(t.DueDate)),
    [tasks]
  )

  const activeTasks = useMemo(
    () => tasks.filter((t) => t.Status !== 'Done' && !isOverdue(t.DueDate)).slice(0, 8),
    [tasks]
  )

  const sortedAgencies = useMemo(
    () => Object.entries(kpis.agencyCounts || {})
      .sort((a, b) => b[1] - a[1]),
    [kpis]
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
    } catch (err) {
      toast?.error(`Failed: ${err.message}`)
    } finally {
      setClosingTask(null)
    }
  }

  const today = new Date()
  const dateStr = today.toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric',
  })

  const displayedTasks = taskTab === 'overdue' ? overdueTasks : activeTasks

  return (
    <>
      <Topbar
        title={user ? getGreeting(user.displayName?.split(' ')[0]) : 'Dashboard'}
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

        {/* ── Row 1: KPI strip ── */}
        <div className={styles.kpiGrid}>
          <KpiCard
            label="Total opportunities"
            value={pLoading ? '—' : kpis.total}
            sub={`${kpis.open} open · ${kpis.closed} awarded`}
          />
          <KpiCard
            label="Pipeline value"
            value={pLoading ? '—' : kpis.totalValueFormatted}
            sub="Active opportunities"
          />
          <KpiCard
            label="Expiring ≤ 90 days"
            value={pLoading ? '—' : kpis.expiringCount}
            sub={kpis.expiringCount > 0 ? 'Review recompetes' : 'None expiring soon'}
            danger={kpis.expiringCount > 0}
          />
          <KpiCard
            label="Overdue tasks"
            value={tLoading ? '—' : kpis.overdueCount}
            sub={kpis.overdueCount > 0 ? 'Needs attention' : 'All on track'}
            danger={kpis.overdueCount > 0}
          />
        </div>

        {/* ── Row 2: Pipeline by phase (full width) ── */}
        <div className="card" style={{ marginBottom: 12 }}>
          <div className={styles.cardTitleRow}>
            <div className={styles.cardTitle}>Pipeline by phase</div>
          </div>
          {pLoading
            ? <div className={`skeleton ${styles.chartSkeleton}`} />
            : <PhaseBarChart byPhase={kpis.byPhase} byPhaseValue={kpis.byPhaseValue} />
          }
        </div>

        {/* ── Row 3: Recent opportunities (full width) ── */}
        <div className="card" style={{ marginBottom: 12 }}>
          <div className={styles.cardTitleRow}>
            <div className={styles.cardTitle}>Recent opportunities</div>
            <button className="btn btn-ghost text-sm"
              onClick={() => navigate('/opportunities')}>View all →</button>
          </div>
          {pLoading
            ? [1, 2, 3].map((i) => <div key={i} className={`skeleton ${styles.rowSkeleton}`} />)
            : recentOpps.length === 0
              ? <p className="text-sm text-muted">No opportunities yet.</p>
              : (
                <div className={styles.consistentTable}>
                  <OppRowHeader />
                  {recentOpps.map((opp) => (
                    <OppRow
                      key={opp[C.contractNum]}
                      opp={opp}
                      onClick={() => navigate(`/opportunities/${encodeURIComponent(opp[C.contractNum])}`)}
                    />
                  ))}
                </div>
              )
          }
        </div>

        {/* ── Row 4: Top agencies (full width, horizontal scroll) ── */}
        <div className="card" style={{ marginBottom: 12 }}>
          <div className={styles.cardTitle}>Opportunities by agency</div>
          {pLoading
            ? <div className={`skeleton ${styles.chartSkeleton}`} style={{ height: 80 }} />
            : sortedAgencies.length === 0
              ? <p className="text-sm text-muted">No agency data.</p>
              : (
                <div className={styles.agencyScroll}>
                  {sortedAgencies.map(([name, count]) => (
                    <AgencyChip key={name} name={name} count={count} />
                  ))}
                </div>
              )
          }
        </div>

        {/* ── Row 5: Tasks (tabbed overdue / active) ── */}
        <div className="card" style={{ marginBottom: 12 }}>
          <div className={styles.cardTitleRow}>
            <div className={styles.tabRow}>
              <button
                className={`${styles.tab} ${taskTab === 'overdue' ? styles.tabActive : ''}`}
                onClick={() => setTaskTab('overdue')}
              >
                Overdue
                {overdueTasks.length > 0 && (
                  <span className={styles.tabBadge}>{overdueTasks.length}</span>
                )}
              </button>
              <button
                className={`${styles.tab} ${taskTab === 'active' ? styles.tabActive : ''}`}
                onClick={() => setTaskTab('active')}
              >
                Active
                {activeTasks.length > 0 && (
                  <span className={styles.tabBadge}>{activeTasks.length}</span>
                )}
              </button>
            </div>
            <button className="btn btn-ghost text-sm"
              onClick={() => navigate('/tasks')}>View all →</button>
          </div>
          {tLoading
            ? [1, 2, 3].map((i) => <div key={i} className={`skeleton ${styles.rowSkeleton}`} />)
            : displayedTasks.length === 0
              ? <p className="text-sm text-muted" style={{ padding: '8px 0' }}>
                  {taskTab === 'overdue' ? 'No overdue tasks — nice work!' : 'No active tasks.'}
                </p>
              : (
                <div className={styles.consistentTable}>
                  <TaskRowHeader />
                  {displayedTasks.map((task) => (
                    <TaskRow
                      key={task.TaskID}
                      task={task}
                      onClose={handleCloseTask}
                      closing={closingTask === task.TaskID}
                    />
                  ))}
                </div>
              )
          }
        </div>

        {/* ── Row 6: Tracked opportunities ── */}
        <div className="card" style={{ marginBottom: 12 }}>
          <div className={styles.cardTitleRow}>
            <div className={styles.cardTitle}>Tracked opportunities</div>
            <button className="btn btn-ghost text-sm"
              onClick={() => navigate('/opportunities')}>View all →</button>
          </div>
          {pLoading
            ? [1, 2].map((i) => <div key={i} className={`skeleton ${styles.rowSkeleton}`} />)
            : (kpis.trackedOpps || []).length === 0
              ? <p className="text-sm text-muted">
                  No tracked opportunities. Set an opportunity's outlook to "Tracking" to monitor it here.
                </p>
              : (
                <div className={styles.consistentTable}>
                  <OppRowHeader />
                  {(kpis.trackedOpps || []).map((opp) => (
                    <OppRow
                      key={opp[C.contractNum]}
                      opp={opp}
                      onClick={() => navigate(`/opportunities/${encodeURIComponent(opp[C.contractNum])}`)}
                    />
                  ))}
                </div>
              )
          }
        </div>
      </div>
    </>
  )
}
