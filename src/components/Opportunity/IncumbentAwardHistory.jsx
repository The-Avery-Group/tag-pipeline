import { useState } from 'react'
import { Bar, BarChart, Cell, Pie, PieChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { useEntityAwardHistory } from '@/hooks/useEntityAwardHistory'
import styles from '@/pages/OpportunityDetail.module.css'

const CHART_COLORS = ['var(--blue-600)', 'var(--chart-phase-research)', 'var(--chart-phase-awarded)', 'var(--chart-phase-pending)', 'var(--chart-phase-qualified)', 'var(--chart-phase-identified)', 'var(--gray-400)']
const PRIME_COLOR = 'var(--blue-600)'
const SUBCONTRACT_COLOR = 'var(--chart-phase-research)'

function fullCurrency(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return '—'
  const sign = number < 0 ? '-' : ''
  return `${sign}$${Math.abs(number).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function compactCurrency(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return ''
  const sign = number < 0 ? '-' : ''
  const absolute = Math.abs(number)
  if (absolute >= 1_000_000_000) return `${sign}$${(absolute / 1_000_000_000).toFixed(1)}B`
  if (absolute >= 1_000_000) return `${sign}$${(absolute / 1_000_000).toFixed(1)}M`
  if (absolute >= 1_000) return `${sign}$${(absolute / 1_000).toFixed(0)}K`
  return `${sign}$${absolute.toFixed(0)}`
}

function roundedAxisLimit(value) {
  if (!value) return 0
  const magnitude = 10 ** Math.floor(Math.log10(Math.abs(value)))
  const scaled = Math.abs(value) / magnitude
  const rounded = scaled <= 1 ? 1 : scaled <= 2 ? 2 : scaled <= 5 ? 5 : 10
  return rounded * magnitude
}

function obligationAxis(series) {
  let negative = 0
  let positive = 0
  series.forEach((item) => {
    const prime = Number(item.primeValue || 0)
    const subcontract = Number(item.subcontractValue || 0)
    negative = Math.min(negative, Math.min(prime, 0) + Math.min(subcontract, 0))
    positive = Math.max(positive, Math.max(prime, 0) + Math.max(subcontract, 0))
  })
  const negativeLimit = negative < 0 ? -roundedAxisLimit(Math.abs(negative) * 1.1) : 0
  const positiveLimit = positive > 0 ? roundedAxisLimit(positive * 1.08) : 1
  const step = roundedAxisLimit(positiveLimit / 4)
  const positiveTicks = Array.from({ length: Math.ceil(positiveLimit / step) + 1 }, (_, index) => index * step)
  return { domain: [negativeLimit, positiveLimit], ticks: [...(negativeLimit ? [negativeLimit] : []), ...positiveTicks] }
}

function valueLabel(value) {
  const input = String(value ?? '').trim()
  const absolute = parseFloat(input.replace(/[^0-9.]/g, ''))
  if (!absolute) return null
  const negative = /^\s*-/.test(input) || /^\s*\(/.test(input)
  const sign = negative ? '-' : ''
  if (absolute >= 1_000_000_000) return `${sign}$${(absolute / 1_000_000_000).toFixed(2)}B`
  if (absolute >= 1_000_000) return `${sign}$${(absolute / 1_000_000).toFixed(1)}M`
  if (absolute >= 1_000) return `${sign}$${(absolute / 1_000).toFixed(0)}K`
  return `${sign}$${absolute.toFixed(0)}`
}

function ActivityTooltip({ active, label, payload }) {
  if (!active || !payload?.length) return null
  return <div className={styles.incumbentChartTooltip}><strong>{label}</strong>{payload.map((item) => (
    <div className={styles.incumbentTooltipRow} key={item.dataKey}><i style={{ background: item.color }} /><span>{item.name}</span><strong>{fullCurrency(item.value)}</strong></div>
  ))}</div>
}

function AgencyTooltip({ active, payload }) {
  if (!active || !payload?.length) return null
  const agency = payload[0]?.payload
  if (!agency) return null
  return <div className={styles.incumbentChartTooltip}><strong>{agency.name}</strong><div className={styles.incumbentTooltipRow}><i style={{ background: agency.color }} /><span>{agency.count} prime contract{agency.count === 1 ? '' : 's'}</span><strong>{agency.percentage.toFixed(1)}%</strong></div><span>{fullCurrency(agency.value)} total award value</span></div>
}

export default function IncumbentAwardHistory({ incumbentUEI, incumbentName }) {
  const valid = /^[A-Z0-9]{12}$/.test(String(incumbentUEI || '').trim().toUpperCase())
  const [open, setOpen] = useState(false)
  const [yearType, setYearType] = useState('calendar')
  const [group, setGroup] = useState('year')
  const { data, loading, error, refresh } = useEntityAwardHistory(valid ? incumbentUEI : '', yearType, group, { enabled: open, includeSubcontracts: true })
  if (!valid) return null
  const series = data?.series || []
  const axis = obligationAxis(series)
  const tickInterval = Math.max(0, Math.ceil(series.length / 12) - 1)
  const agencies = data?.agencies || []
  const agencyCount = agencies.reduce((sum, item) => sum + item.count, 0)
  const leading = agencies.slice(0, 6)
  const remaining = agencies.slice(6).reduce((total, item) => ({ count: total.count + item.count, value: total.value + item.value }), { count: 0, value: 0 })
  const doughnut = [...leading, ...(remaining.count ? [{ name: 'Other agencies', ...remaining }] : [])]
    .map((item, index) => ({ ...item, percentage: agencyCount ? item.count / agencyCount * 100 : 0, color: CHART_COLORS[index % CHART_COLORS.length] }))

  return <div className={styles.incumbentHistory}>
    <button type="button" className={styles.incumbentHistoryHeader} onClick={() => setOpen((value) => !value)} aria-expanded={open}><span><strong>Incumbent award history</strong><small className={styles.incumbentHistoryIdentity}>{String(incumbentName || '').trim() || data?.incumbentName || 'Incumbent name unavailable'} · UEI {String(incumbentUEI).trim().toUpperCase()}</small><small>USAspending.gov · last 5 years</small></span><span>{open ? '⌃' : '⌄'}</span></button>
    {open && <div className={styles.incumbentHistoryBody}>
      <div className={styles.incumbentHistoryControls}>
        <div><button type="button" className={yearType === 'calendar' ? styles.historyControlActive : styles.historyControl} onClick={() => setYearType('calendar')}>Calendar</button><button type="button" className={yearType === 'fiscal' ? styles.historyControlActive : styles.historyControl} onClick={() => setYearType('fiscal')}>Fiscal</button></div>
        <div>{['year', 'quarter', 'month'].map((value) => <button key={value} type="button" className={group === value ? styles.historyControlActive : styles.historyControl} onClick={() => setGroup(value)}>{value}</button>)}</div>
        <button type="button" className="btn btn-ghost text-xs" onClick={refresh} disabled={loading}>Refresh</button>
      </div>
      {loading ? <div className="text-xs text-muted">Loading incumbent award history…</div>
        : error ? <div className="text-xs text-danger">Could not load award history: {error}</div>
        : data && <>
          <div className={styles.incumbentHistoryMetrics}><span><strong>{data.contractCount}</strong> prime contracts</span><span><strong>{valueLabel(data.averageAwardValue) || '—'}</strong> average award</span><span><strong>{data.expiringAwards}</strong> near expiration</span></div>
          <div className={styles.incumbentHistoryContent}>
            <div><div className={styles.incumbentChartTitle}>Net contract obligations</div><div className={styles.incumbentChartLegend} aria-label="Chart legend"><span><i style={{ background: PRIME_COLOR }} />Prime contracts</span>{data.subcontractDataAvailable && <span><i style={{ background: SUBCONTRACT_COLOR }} />Subcontracts</span>}</div><div className={styles.incumbentActivityChart}><ResponsiveContainer width="100%" height="100%"><BarChart data={series} margin={{ top: 18, right: 12, bottom: 4, left: 4 }}><XAxis dataKey="label" interval={tickInterval} tick={{ fontSize: 10, fill: 'var(--gray-600)' }} axisLine={{ stroke: 'var(--gray-300)', strokeWidth: 0.75 }} tickLine={false} /><YAxis width={58} domain={axis.domain} ticks={axis.ticks} tickFormatter={compactCurrency} tick={{ fontSize: 10, fill: 'var(--gray-600)' }} axisLine={{ stroke: 'var(--gray-300)', strokeWidth: 0.75 }} tickLine={false} /><ReferenceLine y={0} stroke="var(--gray-300)" strokeWidth={0.75} /><Tooltip cursor={{ fill: 'var(--gray-50)' }} allowEscapeViewBox={{ x: true, y: true }} wrapperStyle={{ zIndex: 20 }} content={<ActivityTooltip />} /><Bar dataKey="primeValue" name="Prime contracts" stackId="obligations" fill={PRIME_COLOR} radius={[4, 4, 0, 0]} />{data.subcontractDataAvailable && <Bar dataKey="subcontractValue" name="Subcontracts" stackId="obligations" fill={SUBCONTRACT_COLOR} radius={[4, 4, 0, 0]} />}</BarChart></ResponsiveContainer></div></div>
            <div className={styles.incumbentAgencyPanel}><div className={styles.incumbentChartTitle}>Prime contracts by agency</div>{doughnut.length === 0 ? <div className="text-xs text-muted">No agency data.</div> : <div className={styles.incumbentAgencyLayout}><div className={styles.incumbentDoughnut}><ResponsiveContainer width="100%" height="100%"><PieChart><Tooltip allowEscapeViewBox={{ x: true, y: true }} wrapperStyle={{ zIndex: 20 }} content={<AgencyTooltip />} /><Pie data={doughnut} dataKey="count" nameKey="name" innerRadius={55} outerRadius={90} label={({ value }) => `${(agencyCount ? Number(value) / agencyCount * 100 : 0).toFixed(0)}%`} labelLine={false}>{doughnut.map((item) => <Cell key={item.name} fill={item.color} />)}</Pie></PieChart></ResponsiveContainer></div><div className={styles.incumbentHistoryAgencies}>{doughnut.map((agency) => <div key={agency.name} title={`${agency.count} prime contract${agency.count === 1 ? '' : 's'}`}><span>{agency.name}</span><strong>{agency.percentage.toFixed(1)}%</strong></div>)}</div></div>}</div>
          </div>
          <div className={styles.incumbentHistorySource}>USAspending.gov · Last 5 years · {data.cache === 'cache' ? 'cached' : 'live'}{data.subcontractDataAvailable ? '' : ' · Subcontract data unavailable'} · Negative amounts reflect deobligations or downward modifications.</div>
        </>}
    </div>}
  </div>
}
