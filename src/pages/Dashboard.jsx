import { useMemo, useCallback, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '@/auth/AuthContext'
import { usePipeline } from '@/hooks/usePipeline'
import { useTasks } from '@/hooks/useTasks'
import Topbar from '@/components/Layout/Topbar'
import AIPanel from '@/components/AI/AIPanel'
import { computeKPIs, computeRFIByMonth, getGreeting, formatDate, isOverdue, formatCurrency } from '@/utils/kpiHelpers'
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

// Responsive CSS bar chart — no SVG, fills card width naturally
function PhaseBarChart({ byPhase, byPhaseValue }) {
  const entries = Object.entries(byPhase).filter(([, v]) => v > 0)
  if (!entries.length) return <p className="text-sm text-muted">No data</p>

  const maxCount = Math.max(...entries.map(([, v]) => v))

  return (
    <div className={styles.barChart}>
      {entries.map(([phase, count]) => {
        const pct = maxCount > 0 ? (count / maxCount) * 100 : 0
        const color = PHASE_COLORS[phase] || '#85B7EB'
        const val = byPhaseValue[phase] ? formatCurrency(byPhaseValue[phase]) : ''
        return (
          <div key={phase} className={styles.barRow}>
            <span className={styles.barLabel}>{phase}</span>
            <div className={styles.barTrack}>
              <div
                className={styles.barFill}
                style={{ width: `${pct}%`, background: color }}
              />
            </div>
            <span className={styles.barCount}>{count}</span>
            {val && <span className={styles.barValue}>{val}</span>}
          </div>
        )
      })}
    </div>
  )
}

// RFI submissions per month — last 6 months, line chart
function RFILineChart({ data }) {
  if (!data || data.length === 0) return <p className="text-sm text-muted">No data</p>

  const maxCount = Math.max(...data.map((d) => d.count), 1)

  const W      = 600
  const H      = 140
  const PAD_L  = 0    // card padding (14px 16px) handles outer spacing
  const PAD_R  = 0
  const PAD_T  = 20   // room for count labels above points
  const PAD_B  = 20   // room for month labels below
  const innerW = W - PAD_L - PAD_R
  const innerH = H - PAD_T - PAD_B

  const pts = data.map((d, i) => ({
    x: PAD_L + (data.length === 1 ? innerW / 2 : (i / (data.length - 1)) * innerW),
    y: PAD_T + innerH - (d.count / maxCount) * innerH,
    count: d.count,
    label: d.label,
  }))

  const linePath = pts
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(2)},${p.y.toFixed(2)}`)
    .join(' ')

  const areaPath =
    linePath +
    ` L${pts[pts.length - 1].x.toFixed(2)},${(PAD_T + innerH).toFixed(2)}` +
    ` L${pts[0].x.toFixed(2)},${(PAD_T + innerH).toFixed(2)} Z`

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      style={{ width: '100%', height: H, display: 'block' }}
    >
      <defs>
        <linearGradient id="rfiAreaGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"   stopColor="var(--blue-600)" stopOpacity="0.12" />
          <stop offset="100%" stopColor="var(--blue-600)" stopOpacity="0" />
        </linearGradient>
        <clipPath id="rfiClip">
          <rect x={PAD_L} y={PAD_T} width={innerW} height={innerH} />
        </clipPath>
      </defs>

      {/* Area fill */}
      <g clipPath="url(#rfiClip)">
        <path d={areaPath} fill="url(#rfiAreaGrad)" />
      </g>

      {/* Line */}
      <path d={linePath} fill="none"
        stroke="var(--blue-600)" strokeWidth="1.8"
        strokeLinejoin="round" strokeLinecap="round"
      />

      {/* Points, count labels, month labels */}
      {pts.map((p, i) => (
        <g key={i}>
          {p.count > 0 && (
            <text
              x={p.x.toFixed(2)} y={(p.y - 7).toFixed(2)}
              textAnchor="middle" dominantBaseline="auto"
              fontSize="11" fontWeight="600" fill="var(--blue-600)"
            >
              {p.count}
            </text>
          )}
          <circle
            cx={p.x.toFixed(2)} cy={p.y.toFixed(2)}
            r="2"
            fill="#fff" stroke="var(--blue-600)" strokeWidth="1.5"
          />
          {/* Month label — matches barLabel: 11px, var(--gray-600) */}
          <text
            x={p.x.toFixed(2)} y={(PAD_T + innerH + 14).toFixed(2)}
            textAnchor="middle" dominantBaseline="auto"
            fontSize="11" fill="var(--gray-600)"
          >
            {p.label}
          </text>
        </g>
      ))}
    </svg>
  )
}

// Collapsible card wrapper — same visual language as PipelineBoard sections
function CollapsibleCard({ title, count, defaultOpen = false, children, onViewAll }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className={styles.collapsibleCard}>
      <button className={styles.collapsibleHeader} onClick={() => setOpen((v) => !v)}>
        <span className={styles.collapsibleTitle}>{title}</span>
        {count !== undefined && (
          <span className={styles.collapsibleCount}>{count}</span>
        )}
        {onViewAll && open && (
          <span
            className={styles.collapsibleViewAll}
            onClick={(e) => { e.stopPropagation(); onViewAll() }}
          >
            View all
          </span>
        )}
        <span className={`${styles.chevron} ${open ? styles.chevronOpen : ''}`}>›</span>
      </button>
      {open && <div className={styles.collapsibleBody}>{children}</div>}
    </div>
  )
}
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

// Clean agency list row
function AgencyRow({ name, count }) {
  return (
    <div className={styles.agencyRow}>
      <span className={styles.agencyName}>{name}</span>
      <span className={styles.agencyCount}>{count}</span>
    </div>
  )
}

// Tracked opportunity — name + agency only
function TrackedOppRow({ opp, onClick }) {
  return (
    <div className={styles.consistentRow} onClick={onClick}>
      <span className={styles.colTitle}>{opp[C.title]}</span>
      <span className={styles.colAgencyFull}>{opp[C.agency] || '—'}</span>
    </div>
  )
}

function TrackedOppRowHeader() {
  return (
    <div className={`${styles.consistentRow} ${styles.consistentRowHeader}`}>
      <span className={styles.colTitle}>Opportunity</span>
      <span className={styles.colAgencyFull}>Agency</span>
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
  const [taskTab, setTaskTab] = useState('overdue')
  const [expandExpiring, setExpandExpiring] = useState(false)
  const initialPLoad = pLoading && pipeline.length === 0
  const initialTLoad = tLoading && tasks.length === 0

  const rfiData = useMemo(() => computeRFIByMonth(pipeline), [pipeline])

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
            value={initialPLoad ? '—' : kpis.total}
            sub={`${kpis.open} open · ${kpis.closed} awarded`}
          />
          <KpiCard
            label="Pipeline value"
            value={initialPLoad ? '—' : kpis.totalValueFormatted}
            sub="Active opportunities"
          />
          <KpiCard
            label="Expiring ≤ 90 days"
            value={initialPLoad ? '—' : kpis.expiringCount}
            sub={kpis.expiringCount > 0 ? 'Review recompetes' : 'None expiring soon'}
            danger={kpis.expiringCount > 0}
          />
          <KpiCard
            label="Overdue tasks"
            value={initialTLoad ? '—' : kpis.overdueCount}
            sub={kpis.overdueCount > 0 ? 'Needs attention' : 'All on track'}
            danger={kpis.overdueCount > 0}
          />
        </div>

        {/* ── Row 2: Pipeline by phase (full width) ── */}
        <div className="card" style={{ marginBottom: 12 }}>
          <div className={styles.cardTitleRow}>
            <div className={styles.cardTitle}>Pipeline by phase</div>
          </div>
          {initialPLoad
            ? <div className={`skeleton ${styles.chartSkeleton}`} />
            : <PhaseBarChart byPhase={kpis.byPhase} byPhaseValue={kpis.byPhaseValue} />
          }
        </div>

        {/* ── Row 3: RFI submissions by month (full width) ── */}
        <div className="card" style={{ marginBottom: 12 }}>
          <div className={styles.cardTitleRow}>
            <div className={styles.cardTitle}>RFI submissions — last 6 months</div>
          </div>
          {initialPLoad
            ? <div className={`skeleton ${styles.chartSkeleton}`} />
            : <RFILineChart data={rfiData} />
          }
        </div>

        {/* ── Row 4: Recent opportunities (full width) ── */}
        <div className="card" style={{ marginBottom: 12 }}>
          <div className={styles.cardTitleRow}>
            <div className={styles.cardTitle}>Recent opportunities</div>
            <button className="btn btn-ghost text-sm"
              onClick={() => navigate('/opportunities')}>View all →</button>
          </div>
          {initialPLoad
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

        {/* ── Row 5: Expiring contracts (collapsible, first 5 + expand) ── */}
        <CollapsibleCard
          title="Expiring contracts"
          count={kpis.expiringCount}
          onViewAll={kpis.expiringCount > 5 ? () => setExpandExpiring(true) : null}
        >
          {initialPLoad
            ? [1, 2].map((i) => <div key={i} className={`skeleton ${styles.rowSkeleton}`} />)
            : (kpis.expiringOpps || []).length === 0
              ? <p className="text-sm text-muted" style={{ padding: '8px 0' }}>
                  No contracts expiring within 90 days.
                </p>
              : (
                <div className={styles.consistentTable}>
                  <div className={`${styles.consistentRow} ${styles.consistentRowHeader}`}>
                    <span className={styles.colTitle}>Opportunity</span>
                    <span className={styles.colDue}>Expires</span>
                  </div>
                  {(expandExpiring
                    ? kpis.expiringOpps
                    : (kpis.expiringOpps || []).slice(0, 5)
                  ).map((opp) => (
                    <div
                      key={opp[C.contractNum]}
                      className={styles.consistentRow}
                      onClick={() => navigate(`/opportunities/${encodeURIComponent(opp[C.contractNum])}`)}
                    >
                      <span className={styles.colTitle}>{opp[C.title]}</span>
                      <span className={`${styles.colDue} text-muted`}>
                        {formatDate(opp[C.endDate])}
                      </span>
                    </div>
                  ))}
                  {!expandExpiring && (kpis.expiringOpps || []).length > 5 && (
                    <button
                      className={styles.expandBtn}
                      onClick={() => setExpandExpiring(true)}
                    >
                      Show {(kpis.expiringOpps || []).length - 5} more
                    </button>
                  )}
                </div>
              )
          }
        </CollapsibleCard>

        {/* ── Row 6: Top agencies (collapsible) ── */}
        <CollapsibleCard
          title="Opportunities by agency"
          count={sortedAgencies.length}
        >
          {initialPLoad
            ? <div className={`skeleton ${styles.chartSkeleton}`} style={{ height: 80 }} />
            : sortedAgencies.length === 0
              ? <p className="text-sm text-muted">No agency data.</p>
              : (
                <div className={styles.agencyList}>
                  <div className={styles.agencyListHeader}>
                    <span>Agency</span>
                    <span>Opportunities</span>
                  </div>
                  {sortedAgencies.map(([name, count]) => (
                    <AgencyRow key={name} name={name} count={count} />
                  ))}
                </div>
              )
          }
        </CollapsibleCard>

        {/* ── Row 7: Tasks (collapsible, tabbed overdue / active) ── */}
        <CollapsibleCard
          title="Tasks"
          count={overdueTasks.length + activeTasks.length}
          onViewAll={() => navigate('/tasks')}
        >
          <div className={styles.cardTitleRow} style={{ marginBottom: 8 }}>
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
          </div>
          {initialTLoad
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
        </CollapsibleCard>

        {/* ── Row 8: Tracked opportunities (collapsible) ── */}
        <CollapsibleCard
          title="Tracked opportunities"
          count={(kpis.trackedOpps || []).length}
          onViewAll={() => navigate('/opportunities')}
        >
          {initialPLoad
            ? [1, 2].map((i) => <div key={i} className={`skeleton ${styles.rowSkeleton}`} />)
            : (kpis.trackedOpps || []).length === 0
              ? <p className="text-sm text-muted">
                  No tracked opportunities. Set an opportunity's outlook to "Tracking" to monitor it here.
                </p>
              : (
                <div className={styles.consistentTable}>
                  <TrackedOppRowHeader />
                  {(kpis.trackedOpps || []).map((opp) => (
                    <TrackedOppRow
                      key={opp[C.contractNum]}
                      opp={opp}
                      onClick={() => navigate(`/opportunities/${encodeURIComponent(opp[C.contractNum])}`)}
                    />
                  ))}
                </div>
              )
          }
        </CollapsibleCard>
      </div>
    </>
  )
}
