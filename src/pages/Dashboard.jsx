import { useMemo, useCallback, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, Cell, ResponsiveContainer,
  PieChart, Pie, AreaChart, Area, LabelList,
} from 'recharts'
import { useAuth } from '@/auth/AuthContext'
import { usePipeline } from '@/hooks/usePipeline'
import { useTasks } from '@/hooks/useTasks'
import { useScrollRestoration } from '@/hooks/useScrollRestoration'
import Topbar from '@/components/Layout/Topbar'
import AIPanel from '@/components/AI/AIPanel'
import {
  computeKPIs, computeSubmissionsByMonth, computeExpiringBands, computeContractTimeline,
  computeAwardTypeBreakdown, computeVehicleBreakdown, computeSubPrimeBreakdown,
  getGreeting, formatDate, isOverdue, formatCurrency, getEndDateBand, EXPIRING_BANDS,
} from '@/utils/kpiHelpers'
import { buildPipelineSummaryContext } from '@/services/groqService'
import styles from './Dashboard.module.css'
import { useOpportunityAlerts } from '@/hooks/useOpportunityAlerts'
import { acknowledgeOpportunityAlert } from '@/services/opportunityAlertService'

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
  'Identified':       'var(--chart-phase-identified)',
  'Research':         'var(--chart-phase-research)',
  'Qualified':        'var(--chart-phase-qualified)',
  'Proposal':         'var(--chart-phase-proposal)',
  'Pending Award':    'var(--chart-phase-pending)',
  'Contract Awarded': 'var(--chart-phase-awarded)',
  'Closed Lost':      'var(--chart-phase-cancelled)',
  'Cancelled':        'var(--chart-phase-cancelled)',
}

const PHASE_BADGE = {
  'Identified':       'badge-tracking',
  'Research':         'badge-qualify',
  'Qualified':        'badge-qualify',
  'Proposal':         'badge-proposal',
  'Pending Award':    'badge-negotiation',
  'Contract Awarded': 'badge-award',
  'Closed Lost':      'badge-closed-lost',
  'Cancelled':        'badge-closed-lost',
}

// Shared minimal, muted palette for the categorical charts (contract classification,
// Vehicle, Sub/Prime) — kept in the same restrained family as PHASE_COLORS
// rather than reaching for a louder default Recharts palette.
const CATEGORY_COLORS = [
  'var(--chart-phase-proposal)', 'var(--chart-phase-research)', 'var(--chart-phase-awarded)',
  'var(--chart-phase-pending)', 'var(--chart-phase-qualified)', 'var(--chart-phase-identified)',
  'var(--chart-phase-cancelled)',
]

// Shared tooltip — small, minimal, matches the app's card styling rather
// than Recharts' default tooltip chrome.
function ChartTooltip({ active, payload, formatLabel, formatValue }) {
  if (!active || !payload?.length) return null
  const d = payload[0].payload
  return (
    <div style={{
      background: 'var(--surface-raised)', border: '0.5px solid var(--gray-200)', borderRadius: 8,
      padding: '6px 10px', fontSize: 12, boxShadow: '0 2px 8px var(--shadow-color)',
    }}>
      <div style={{ fontWeight: 600, color: 'var(--gray-900)' }}>{formatLabel ? formatLabel(d) : d.label}</div>
      <div style={{ color: 'var(--gray-600)' }}>{formatValue ? formatValue(d) : `${d.count} opportunities`}</div>
    </div>
  )
}

// ── Sub-components ────────────────────────────────────────────────────────

function KpiCard({ label, value, sub, danger, onClick, title }) {
  return (
    <div
      className={styles.kpiCard}
      title={title}
      onClick={onClick}
      style={onClick ? { cursor: 'pointer' } : undefined}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={onClick ? (e) => { if (e.key === 'Enter') onClick() } : undefined}
    >
      <div className={styles.kpiLabel}>{label}</div>
      <div className={`${styles.kpiValue} ${danger ? styles.kpiDanger : ''}`}>{value}</div>
      {sub && <div className={`${styles.kpiDelta} ${danger ? styles.kpiDeltaDanger : ''}`}>{sub}</div>}
    </div>
  )
}

// Pipeline by phase — horizontal bar, height scales with category count so a
// card with 3 phases isn't stretched as tall as one with 6. Contract Awarded
// is intentionally excluded (1e — a closed/won phase isn't useful noise in
// an "active pipeline shape" chart). Clicking a bar navigates to the
// Opportunities page filtered to that phase.
function PhaseBarChart({ byPhase, byPhaseValue, onSegmentClick }) {
  const data = Object.entries(byPhase)
    .filter(([phase, v]) => v > 0 && phase !== 'Contract Awarded')
    .map(([phase, count]) => ({ phase, label: phase, count, value: byPhaseValue[phase] || 0 }))

  if (!data.length) return <p className="text-sm text-muted">No data</p>

  return (
    <ResponsiveContainer width="100%" height={Math.max(140, data.length * 40)}>
      <BarChart data={data} layout="vertical" margin={{ top: 4, right: 36, bottom: 4, left: 4 }}>
        <XAxis type="number" hide allowDecimals={false} />
        <YAxis type="category" dataKey="phase" width={110} tick={{ fontSize: 11, fill: 'var(--gray-600)' }} axisLine={false} tickLine={false} />
        <Tooltip
          cursor={{ fill: 'var(--gray-50)' }}
          content={<ChartTooltip formatValue={(d) => `${d.count} opportunities${d.value ? ` · ${formatCurrency(d.value)}` : ''}`} />}
        />
        <Bar
          dataKey="count" radius={[0, 4, 4, 0]} cursor="pointer" maxBarSize={28}
          onClick={(d) => onSegmentClick?.(d?.payload?.phase ?? d?.phase)}
        >
          {data.map((d) => <Cell key={d.phase} fill={PHASE_COLORS[d.phase] || 'var(--chart-phase-proposal)'} />)}
          <LabelList dataKey="count" position="right" style={{ fontSize: 11, fontWeight: 600, fill: 'var(--gray-900)' }} />
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  )
}

function SubmissionTooltip({ active, payload }) {
  if (!active || !payload?.length) return null
  const item = payload[0].payload
  const typeRows = ['RFI', 'MRAS', 'RFP', 'RFQ', 'Unclassified']
    .filter((type) => Number(item.types?.[type] || 0) > 0)
  return (
    <div style={{
      minWidth: 170, background: 'var(--surface-raised)', border: '0.5px solid var(--gray-200)',
      borderRadius: 8, padding: '8px 10px', fontSize: 12, boxShadow: '0 2px 8px var(--shadow-color)',
    }}>
      <div style={{ fontWeight: 600, color: 'var(--gray-900)', marginBottom: 5 }}>{item.label}</div>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 18, color: 'var(--gray-800)', fontWeight: 600 }}>
        <span>Total submitted</span><span>{item.count}</span>
      </div>
      {typeRows.map((type) => (
        <div key={type} style={{ display: 'flex', justifyContent: 'space-between', gap: 18, color: 'var(--gray-600)', marginTop: 3 }}>
          <span>{type}</span><span>{item.types[type]}</span>
        </div>
      ))}
    </div>
  )
}

// Submissions: one total line, with the notice-type mix in the tooltip. Click
// a point to navigate to the Responses tab filtered to that submitted month.
// XAxis padding
// keeps the first/last points and labels from clipping against the card edge.
function SubmissionChart({ data, onMonthClick }) {
  if (!data || data.length === 0) return <p className="text-sm text-muted">No data</p>

  return (
    <ResponsiveContainer width="100%" height={260}>
      <AreaChart
        data={data} margin={{ top: 24, right: 20, bottom: 4, left: 20 }}
        onClick={(e) => { if (e?.activePayload?.[0]) onMonthClick?.(e.activePayload[0].payload) }}
      >
        <defs>
          <linearGradient id="rfiGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%"   stopColor="var(--blue-600)" stopOpacity={0.16} />
            <stop offset="100%" stopColor="var(--blue-600)" stopOpacity={0} />
          </linearGradient>
        </defs>
        <XAxis dataKey="label" tick={{ fontSize: 11, fill: 'var(--gray-600)' }} axisLine={false} tickLine={false}
          padding={{ left: 16, right: 16 }} />
        <YAxis hide allowDecimals={false} />
        <Tooltip content={<SubmissionTooltip />} />
        <Area
          type="monotone" dataKey="count" cursor="pointer"
          stroke="var(--blue-600)" strokeWidth={2.5} fill="url(#rfiGrad)"
          dot={{ r: 3, fill: 'var(--surface)', stroke: 'var(--blue-600)', strokeWidth: 1.5 }}
          activeDot={{ r: 5 }}
          label={({ x, y, value }) => value > 0
            ? <text x={x} y={y - 12} textAnchor="middle" fontSize={11} fontWeight={600} fill="var(--blue-600)">{value}</text>
            : null
          }
        />
      </AreaChart>
    </ResponsiveContainer>
  )
}

// Compact categorical bar chart shared by contract classification and vehicle
// Vehicle breakdowns, both of which can have several distinct values.
function CategoryBarChart({ counts, onSegmentClick }) {
  const data = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([label, count]) => ({ label, count }))

  if (!data.length) return <p className="text-sm text-muted">No data</p>

  return (
    <ResponsiveContainer width="100%" height={Math.max(120, data.length * 36)}>
      <BarChart data={data} layout="vertical" margin={{ top: 4, right: 36, bottom: 4, left: 4 }}>
        <XAxis type="number" hide allowDecimals={false} />
        <YAxis type="category" dataKey="label" width={130} tick={{ fontSize: 11, fill: 'var(--gray-600)' }} axisLine={false} tickLine={false} />
        <Tooltip cursor={{ fill: 'var(--gray-50)' }} content={<ChartTooltip />} />
        <Bar dataKey="count" radius={[0, 4, 4, 0]} cursor="pointer" maxBarSize={24}
          onClick={(d) => onSegmentClick?.(d?.payload?.label ?? d?.label)}>
          {data.map((d, i) => <Cell key={d.label} fill={CATEGORY_COLORS[i % CATEGORY_COLORS.length]} />)}
          <LabelList dataKey="count" position="right" style={{ fontSize: 11, fontWeight: 600, fill: 'var(--gray-900)' }} />
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  )
}

// Sub/Prime — a genuine two-value split, donut fits this better than bars.
// No gridlines/axes on a pie chart to begin with; already has labels + tooltip.
function SubPrimeChart({ counts, onSegmentClick }) {
  const data = Object.entries(counts).map(([label, count]) => ({ label, count }))
  if (!data.length) return <p className="text-sm text-muted">No data</p>
  const colorFor = { Prime: 'var(--blue-600)', Sub: 'var(--chart-phase-research)' }

  return (
    <ResponsiveContainer width="100%" height={200}>
      <PieChart>
        <Tooltip content={<ChartTooltip />} />
        <Pie
          data={data} dataKey="count" nameKey="label"
          cx="50%" cy="50%" innerRadius={50} outerRadius={80}
          paddingAngle={2} cursor="pointer"
          onClick={(d) => onSegmentClick?.(d?.label)}
          label={({ label, count }) => `${label} (${count})`}
          labelLine={false}
        >
          {data.map((d) => <Cell key={d.label} fill={colorFor[d.label] || 'var(--chart-phase-proposal)'} />)}
        </Pie>
      </PieChart>
    </ResponsiveContainer>
  )
}

// Recompete timeline grouped by calendar year using
// Contract End Date. Click a bar to navigate filtered to that year.
function ContractTimelineChart({ data, onPeriodClick }) {
  if (!data || data.every((d) => d.count === 0)) return <p className="text-sm text-muted">No data</p>

  return (
    <ResponsiveContainer width="100%" height={260}>
      <BarChart data={data} margin={{ top: 20, right: 12, bottom: 4, left: 0 }}>
        <XAxis dataKey="label" tick={{ fontSize: 11, fill: 'var(--gray-600)' }} axisLine={false} tickLine={false} />
        <YAxis hide allowDecimals={false} />
        <Tooltip cursor={{ fill: 'var(--gray-50)' }}
          content={<ChartTooltip formatLabel={(d) => d.fullLabel || d.label} formatValue={(d) => `${d.count} contract${d.count === 1 ? '' : 's'}${d.value ? ` · ${formatCurrency(d.value)}` : ''}`} />} />
        <Bar dataKey="count" radius={[4, 4, 0, 0]} cursor="pointer" fill="var(--blue-600)" maxBarSize={44}
          onClick={(d) => onPeriodClick?.(d?.payload ?? d)}
        >
          <LabelList dataKey="count" position="top" style={{ fontSize: 11, fontWeight: 600, fill: 'var(--gray-900)' }}
            formatter={(v) => v > 0 ? v : ''} />
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  )
}

// Opportunities by agency — same shape as the Phase chart, click navigates
// filtered to that agency. Wider label column + no numeric axis (data
// labels on the bars instead) so long agency names have room to breathe.
function AgencyChart({ sortedAgencies, onSegmentClick }) {
  const data = sortedAgencies.slice(0, 12).map(([label, count]) => ({ label, count }))
  if (!data.length) return <p className="text-sm text-muted">No agency data.</p>

  return (
    <ResponsiveContainer width="100%" height={Math.max(160, data.length * 32)}>
      <BarChart data={data} layout="vertical" margin={{ top: 4, right: 36, bottom: 4, left: 4 }}>
        <XAxis type="number" hide allowDecimals={false} />
        <YAxis type="category" dataKey="label" width={280} tick={{ fontSize: 11, fill: 'var(--gray-600)' }} axisLine={false} tickLine={false} />
        <Tooltip cursor={{ fill: 'var(--gray-50)' }} content={<ChartTooltip />} />
        <Bar dataKey="count" radius={[0, 4, 4, 0]} cursor="pointer" fill="var(--blue-600)" maxBarSize={16}
          onClick={(d) => onSegmentClick?.(d?.payload?.label ?? d?.label)}
        >
          <LabelList dataKey="count" position="right" style={{ fontSize: 11, fontWeight: 600, fill: 'var(--gray-900)' }} />
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  )
}


// Collapsible card wrapper — same visual language as PipelineBoard sections
function CollapsibleCard({ title, count, countDanger = false, defaultOpen = true, children, onViewAll }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className={styles.collapsibleCard}>
      <button className={styles.collapsibleHeader} onClick={() => setOpen((v) => !v)}>
        <span className={styles.collapsibleTitle}>{title}</span>
        {count !== undefined && (
          <span className={`${styles.collapsibleCount} ${countDanger && count > 0 ? styles.collapsibleCountDanger : ''}`}>{count}</span>
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
function TaskRow({ task, onClose, closing, onRowClick }) {
  const overdue = isOverdue(task.DueDate)
  return (
    <div className={styles.consistentRow} onClick={() => onRowClick?.(task)}>
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
          onClick={(e) => { e.stopPropagation(); onClose(task) }}
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

// ── Main component ────────────────────────────────────────────────────────

export default function Dashboard({ toast }) {
  const { user } = useAuth()
  const navigate = useNavigate()
  useScrollRestoration()   // restores page scroll position on back-navigation from a detail page
  const { pipeline, loading: pLoading } = usePipeline()
  const { tasks, loading: tLoading, update: updateTask } = useTasks()
  const reviewQueue = useOpportunityAlerts()
  const [closingTask, setClosingTask] = useState(null)
  const [taskTab, setTaskTab] = useState('overdue')
  const [expandExpiring, setExpandExpiring] = useState(false)
  // Expiring band replaces the old day-preset chips (30/60/90/6mo/12mo/24mo)
  // with the same 4 fixed bands used as an Opportunities-page filter —
  // custom range is kept as-is per explicit request.
  const [expiringBand, setExpiringBand] = useState('0-6')
  const [expiringFrom, setExpiringFrom] = useState('')
  const [expiringTo, setExpiringTo] = useState('')
  const [expiringCustom, setExpiringCustom] = useState(false)
  const [timelineGrouping, setTimelineGrouping] = useState('year')
  const [timelineBasis, setTimelineBasis] = useState('fiscal')
  const initialPLoad = pLoading && pipeline.length === 0
  const initialTLoad = tLoading && tasks.length === 0

  // Navigate to Opportunities with filters pre-applied — the single
  // mechanism every chart/KPI drilldown uses. Filters show up as real,
  // dismissible chips exactly as if the user had applied them manually,
  // since Opportunities.jsx's filter state lives in the URL.
  const goToOpportunities = useCallback((params) => {
    const qs = new URLSearchParams(params).toString()
    navigate(`/opportunities${qs ? `?${qs}` : ''}`)
  }, [navigate])

  const submissionData     = useMemo(() => computeSubmissionsByMonth(pipeline, 10), [pipeline])
  const contractTimelineData = useMemo(() => computeContractTimeline(pipeline, { grouping: timelineGrouping, basis: timelineBasis }), [pipeline, timelineGrouping, timelineBasis])
  const awardTypeCounts    = useMemo(() => computeAwardTypeBreakdown(pipeline), [pipeline])
  const vehicleCounts      = useMemo(() => computeVehicleBreakdown(pipeline), [pipeline])
  const subPrimeCounts     = useMemo(() => computeSubPrimeBreakdown(pipeline), [pipeline])
  const expiringBandCounts = useMemo(() => computeExpiringBands(pipeline), [pipeline])

  const filteredExpiringOpps = useMemo(() => {
    const today = new Date(); today.setHours(0, 0, 0, 0)
    const C_END = 'Contract End Date*'
    if (expiringCustom && expiringFrom && expiringTo) {
      const from = new Date(expiringFrom + 'T00:00:00')
      const to   = new Date(expiringTo   + 'T00:00:00')
      return pipeline.filter((o) => {
        const d = new Date((o[C_END] || '') + 'T00:00:00')
        return !isNaN(d) && d >= from && d <= to
      }).sort((a, b) => new Date(a[C_END]) - new Date(b[C_END]))
    }
    return pipeline.filter((o) => getEndDateBand(o[C_END]) === expiringBand)
      .sort((a, b) => new Date(a[C_END]) - new Date(b[C_END]))
  }, [pipeline, expiringBand, expiringFrom, expiringTo, expiringCustom])

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
    () => buildPipelineSummaryContext(kpis, pipeline),
    [kpis, pipeline]
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
          promptType="pipeline_summary"
          buildPrompt={aiPrompt}
          defaultCollapsed={true}
        />

        <CollapsibleCard title="Review queue" count={reviewQueue.alerts.length} countDanger defaultOpen={false}>
          {reviewQueue.loading ? <div className={`skeleton ${styles.rowSkeleton}`} />
            : reviewQueue.alerts.length === 0 ? <p className="text-sm text-muted">No unreviewed opportunity changes.</p>
            : <div className={styles.reviewQueue}>
              {reviewQueue.alerts.map((alert) => (
                <div className={styles.reviewQueueRow} key={`${alert.opportunityKey}:${alert.type}:${alert.fingerprint}`}>
                  <button type="button" className={styles.reviewQueueLink} onClick={() => {
                    const matchedOpportunity = pipeline.find((opportunity) => [
                      opportunity[C.contractNum],
                      opportunity['Solicitation Number'],
                    ].some((value) => String(value || '').trim().toLowerCase() === String(alert.opportunityKey || '').trim().toLowerCase()))
                    const identifier = matchedOpportunity?.[C.contractNum] || alert.opportunityKey
                    const key = encodeURIComponent(identifier)
                    const row = matchedOpportunity?._rowIndex != null ? `&row=${matchedOpportunity._rowIndex}` : ''
                    navigate(alert.type?.includes('file')
                      ? `/opportunities/${key}/dossier?focus=files&alert=${encodeURIComponent(alert.type)}${row}`
                      : alert.type === 'award_notice'
                        ? `/opportunities/${key}?focus=awards${row}`
                        : `/opportunities/${key}${row ? `?${row.slice(1)}` : ''}`)
                  }}>
                    <strong>{alert.summary || alert.opportunityKey}</strong>
                    <small>{alert.details?.currentDate || alert.details?.awardeeName || alert.details?.piid || alert.opportunityKey}</small>
                  </button>
                  <button className="btn btn-sm" onClick={async () => {
                    try {
                      await acknowledgeOpportunityAlert(alert.opportunityKey, alert.type, alert.fingerprint)
                      await reviewQueue.refresh({ silent: true })
                    } catch (error) { toast?.error(`Could not mark reviewed: ${error.message}`) }
                  }}>Mark reviewed</button>
                </div>
              ))}
            </div>}
        </CollapsibleCard>

        {/* ── Row 1: KPI strip ── */}
        <div className={styles.kpiGrid}>
          <KpiCard
            label="Total opportunities"
            value={initialPLoad ? '—' : kpis.total}
            sub={`${kpis.open} open · ${kpis.closed} awarded`}
            onClick={() => goToOpportunities({ tab: 'All' })}
          />
          <KpiCard
            label="Pipeline value"
            value={initialPLoad ? '—' : kpis.totalValueFormatted}
            sub="Open opportunities"
          />
          <KpiCard
            label="Expiring in 6 months"
            title="Contracts expiring within 6 months"
            value={initialPLoad ? '—' : expiringBandCounts['0-6']}
            sub={expiringBandCounts['0-6'] > 0 ? 'Review recompetes' : 'None expiring soon'}
            danger={expiringBandCounts['0-6'] > 0}
            onClick={() => goToOpportunities({ tab: 'Expiring', endBand: '0-6' })}
          />
          <KpiCard
            label="Overdue tasks"
            value={initialTLoad ? '—' : kpis.overdueCount}
            sub={kpis.overdueCount > 0 ? 'Needs attention' : 'All on track'}
            danger={kpis.overdueCount > 0}
            onClick={() => navigate('/tasks?status=overdue')}
          />
          <KpiCard
            label="Pending Award"
            value={initialPLoad ? '—' : kpis.pendingAward}
            sub="Submitted RFPs awaiting a decision"
            onClick={() => goToOpportunities({ tab: 'All', phase: 'Pending Award' })}
          />
          <KpiCard
            label="Company PWIN"
            value={initialPLoad ? '—' : `${kpis.companyPwin.toFixed(1)}%`}
            sub={`${kpis.won} won · ${kpis.submittedRfpCount} submitted · ${kpis.decidedPwin.toFixed(1)}% decided`}
          />
        </div>

        {/* ── Row 2: Pipeline by phase (full width) ── */}
        <div className="card" style={{ marginBottom: 12 }}>
          <div className={styles.cardTitleRow}>
            <div className={styles.cardTitle}>Pipeline by phase</div>
          </div>
          {initialPLoad
            ? <div className={`skeleton ${styles.chartSkeleton}`} />
            : <PhaseBarChart byPhase={kpis.byPhase} byPhaseValue={kpis.byPhaseValue}
                onSegmentClick={(phase) => goToOpportunities({ tab: 'All', phase })} />
          }
        </div>

        {/* Row 3: submissions, full width */}
        <div className="card" style={{ marginBottom: 12 }}>
          <div className={styles.cardTitleRow}>
            <div className={styles.cardTitle}>Submissions by month</div>
          </div>
          {initialPLoad
            ? <div className={`skeleton ${styles.chartSkeleton}`} />
            : <SubmissionChart data={submissionData}
                onMonthClick={(m) => goToOpportunities({ tab: 'Responses', rfiMonth: m.monthKey })} />
          }
        </div>

        {/* Row 4: Contract classification, vehicle, and prime or sub */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
          <div className="card">
            <div className={styles.cardTitleRow}>
              <div className={styles.cardTitle}>Contract classification</div>
            </div>
            {initialPLoad
              ? <div className={`skeleton ${styles.chartSkeleton}`} />
              : <CategoryBarChart counts={awardTypeCounts}
                  onSegmentClick={(classification) => goToOpportunities({ tab: 'All', classification })} />
            }
          </div>
          <div className="card">
            <div className={styles.cardTitleRow}>
              <div className={styles.cardTitle}>Contract vehicle</div>
            </div>
            {initialPLoad
              ? <div className={`skeleton ${styles.chartSkeleton}`} />
              : <CategoryBarChart counts={vehicleCounts}
                  onSegmentClick={(vehicle) => goToOpportunities({ tab: 'All', vehicle })} />
            }
          </div>
          <div className="card">
            <div className={styles.cardTitleRow}>
              <div className={styles.cardTitle}>Prime or sub</div>
            </div>
            {initialPLoad
              ? <div className={`skeleton ${styles.chartSkeleton}`} />
              : <SubPrimeChart counts={subPrimeCounts}
                  onSegmentClick={(primeOrSub) => goToOpportunities({ tab: 'All', primeOrSub })} />
            }
          </div>
        </div>

        <div className="card" style={{ marginBottom: 12 }}>
          <div className={styles.cardTitleRow}>
            <div className={styles.cardTitle}>Recompete timeline</div>
            <div style={{ display: 'flex', gap: 6 }}>
              <select className="form-input" aria-label="Timeline grouping" value={timelineGrouping} onChange={(event) => setTimelineGrouping(event.target.value)} style={{ width: 'auto' }}><option value="year">Years</option><option value="quarter">Quarters</option></select>
              <select className="form-input" aria-label="Timeline calendar basis" value={timelineBasis} onChange={(event) => setTimelineBasis(event.target.value)} style={{ width: 'auto' }}><option value="fiscal">Federal fiscal</option><option value="calendar">Calendar</option></select>
            </div>
          </div>
          {initialPLoad ? <div className={`skeleton ${styles.chartSkeleton}`} /> : <ContractTimelineChart data={contractTimelineData} onPeriodClick={(period) => goToOpportunities({ tab: 'All', endYear: period.year, endQuarter: timelineGrouping === 'quarter' ? period.quarter : undefined, yearBasis: timelineBasis })} />}
        </div>

        {/* ── Row 5: Opportunities by agency (plain card, not collapsible) ── */}
        <div className="card" style={{ marginBottom: 12 }}>
          <div className={styles.cardTitleRow}>
            <div className={styles.cardTitle}>Opportunities by agency</div>
          </div>
          {initialPLoad
            ? <div className={`skeleton ${styles.chartSkeleton}`} style={{ height: 80 }} />
            : <AgencyChart sortedAgencies={sortedAgencies}
                onSegmentClick={(agency) => goToOpportunities({ tab: 'All', agency })} />
          }
        </div>

        {/* ── Row 6: Expiring contracts (collapsible, band selector) ── */}
        <CollapsibleCard
          title="Expiring contracts"
          count={filteredExpiringOpps.length}
          onViewAll={filteredExpiringOpps.length > 5 ? () => setExpandExpiring(true) : null}
        >
          {/* Band selector */}
          <div className={styles.expiringControls}>
            {EXPIRING_BANDS.map(({ key, label }) => (
              <button key={key}
                className={`filter-chip ${!expiringCustom && expiringBand === key ? 'active' : ''}`}
                onClick={() => { setExpiringBand(key); setExpiringCustom(false); setExpandExpiring(false) }}>
                {label}
              </button>
            ))}
            <button
              className={`filter-chip ${expiringCustom ? 'active' : ''}`}
              onClick={() => setExpiringCustom(true)}>
              Custom range
            </button>
            <button
              className="btn btn-ghost text-sm" style={{ marginLeft: 'auto' }}
              onClick={() => goToOpportunities(
                expiringCustom ? { tab: 'Expiring' } : { tab: 'Expiring', endBand: expiringBand }
              )}
            >
              View opportunities →
            </button>
          </div>
          {expiringCustom && (
            <div style={{ display: 'flex', gap: 8, margin: '8px 0', alignItems: 'center' }}>
              <input type="date" className="form-input" style={{ flex: 1 }}
                value={expiringFrom} onChange={(e) => setExpiringFrom(e.target.value)} />
              <span className="text-sm text-muted">to</span>
              <input type="date" className="form-input" style={{ flex: 1 }}
                value={expiringTo} onChange={(e) => setExpiringTo(e.target.value)} />
            </div>
          )}
          {initialPLoad
            ? [1, 2].map((i) => <div key={i} className={`skeleton ${styles.rowSkeleton}`} />)
            : filteredExpiringOpps.length === 0
              ? <p className="text-sm text-muted" style={{ padding: '8px 0' }}>
                  No contracts expiring in this period.
                </p>
              : (
                <div className={styles.consistentTable}>
                  <div className={`${styles.consistentRow} ${styles.consistentRowHeader}`}>
                    <span className={styles.colTitle}>Opportunity</span>
                    <span className={styles.colDue}>Expires</span>
                  </div>
                  {(expandExpiring ? filteredExpiringOpps : filteredExpiringOpps.slice(0, 5))
                    .map((opp) => (
                      <div key={opp[C.contractNum]}
                        className={styles.consistentRow}
                        onClick={() => navigate(`/opportunities/${encodeURIComponent(opp[C.contractNum])}`)}
                      >
                        <span className={styles.colTitle}>{opp[C.title]}</span>
                        <span className={`${styles.colDue} text-muted`}>
                          {formatDate(opp[C.endDate])}
                        </span>
                      </div>
                    ))
                  }
                  {!expandExpiring && filteredExpiringOpps.length > 5 && (
                    <button className={styles.expandBtn}
                      onClick={() => setExpandExpiring(true)}>
                      Show {filteredExpiringOpps.length - 5} more
                    </button>
                  )}
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
                Open
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
                      onRowClick={(t) => navigate(`/tasks?taskId=${encodeURIComponent(t.TaskID)}`)}
                    />
                  ))}
                </div>
              )
          }
        </CollapsibleCard>

        {/* ── Row 8: Recent opportunities (moved from the top, now collapsible) ── */}
        <CollapsibleCard
          title="Recently updated opportunities"
          count={recentOpps.length}
          onViewAll={() => navigate('/opportunities')}
        >
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
        </CollapsibleCard>
      </div>
    </>
  )
}
