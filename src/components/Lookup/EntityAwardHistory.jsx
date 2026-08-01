import { useState } from 'react'
import { Bar, BarChart, Cell, LabelList, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { useEntityAwardHistory } from '@/hooks/useEntityAwardHistory'
import { formatCurrency } from '@/utils/kpiHelpers'
import styles from './EntityAwardHistory.module.css'

const CHART_COLORS = [
  'var(--blue-600)', 'var(--chart-phase-research)', 'var(--chart-phase-awarded)',
  'var(--chart-phase-pending)', 'var(--chart-phase-qualified)', 'var(--chart-phase-identified)',
  'var(--chart-phase-cancelled)',
]

function ChartTooltip({ active, payload, formatLabel, formatValue }) {
  if (!active || !payload?.length) return null
  const item = payload[0].payload
  return (
    <div className={styles.tooltip}>
      <div className={styles.tooltipTitle}>{formatLabel ? formatLabel(item) : item.label}</div>
      <div className={styles.tooltipValue}>{formatValue ? formatValue(item) : formatCurrency(item.value)}</div>
    </div>
  )
}

function Metric({ label, value, detail, danger = false }) {
  return (
    <div className={styles.metric}>
      <span>{label}</span>
      <strong className={danger ? styles.metricDanger : undefined}>{value}</strong>
      <small>{detail}</small>
    </div>
  )
}

export default function EntityAwardHistory() {
  const [uei, setUEI] = useState(() => localStorage.getItem('tag_entity_uei') || '')
  const [submittedUEI, setSubmittedUEI] = useState(() => localStorage.getItem('tag_entity_uei') || '')
  const [yearType, setYearType] = useState('calendar')
  const [group, setGroup] = useState('year')
  const { data, loading, error, refresh } = useEntityAwardHistory(submittedUEI, yearType, group)
  const agencies = data?.departments || data?.agencies || []
  const total = agencies.reduce((sum, item) => sum + item.count, 0)
  const doughnut = agencies.slice(0, 8).map((item) => ({ ...item, percentage: total ? item.count / total * 100 : 0 }))

  const submit = (event) => {
    event.preventDefault()
    const value = uei.trim().toUpperCase()
    localStorage.setItem('tag_entity_uei', value)
    setUEI(value)
    setSubmittedUEI(value)
  }

  return (
    <section className={styles.panel} aria-label="Entity award history">
      <div className={styles.heading}>
        <div>
          <h2>Entity award history</h2>
          <p>Prime contract activity reported by USAspending.gov over the last five years.</p>
        </div>
      </div>

      <form className={styles.controls} onSubmit={submit}>
        <input className="form-input" value={uei} maxLength={12} placeholder="Company UEI" onChange={(event) => setUEI(event.target.value.toUpperCase())} />
        <button className="btn btn-primary text-sm" type="submit">Load</button>
        <div className={styles.choiceGroup} aria-label="Year type">
          <button type="button" className={yearType === 'calendar' ? styles.choiceActive : styles.choice} onClick={() => setYearType('calendar')}>Calendar year</button>
          <button type="button" className={yearType === 'fiscal' ? styles.choiceActive : styles.choice} onClick={() => setYearType('fiscal')}>Fiscal year</button>
        </div>
        <div className={styles.choiceGroup} aria-label="Time grouping">
          {['year', 'quarter', 'month'].map((value) => (
            <button key={value} type="button" className={group === value ? styles.choiceActive : styles.choice} onClick={() => setGroup(value)}>{value[0].toUpperCase() + value.slice(1)}</button>
          ))}
        </div>
        {data && <button className="btn btn-ghost text-sm" type="button" onClick={refresh} disabled={loading}>Refresh</button>}
      </form>

      {!submittedUEI ? <p className="text-sm text-muted">Enter an entity UEI to view its award history.</p>
        : loading ? <div className={`skeleton ${styles.skeleton}`} />
          : error ? <p className="text-sm text-danger">Could not load award history: {error}</p>
            : data && <>
              <div className={styles.entityIdentity}>
                <span>Incumbent</span>
                <strong>{data.incumbentName || 'Name unavailable from USAspending'}</strong>
                <small>UEI {data.uei}</small>
              </div>
              <div className={styles.metrics}>
                <Metric label="Prime contracts" value={data.contractCount} detail="Last five years" />
                <Metric label="Average award value" value={formatCurrency(data.averageAwardValue)} detail="Award amounts in period" />
                <Metric label="Award value" value={formatCurrency(data.totalAwardValue)} detail="Last five years" />
                <Metric label="Near expiration" value={data.expiringAwards} detail="Ends within 6 months" danger={data.expiringAwards > 0} />
              </div>
              {data.truncated && <p className="text-xs text-muted">Agency counts cover the first {data.displayedAwardCount} awards. The total contract count remains exact.</p>}
              <div className={styles.charts}>
                <div>
                  <h3>Prime contract activity</h3>
                  <ResponsiveContainer width="100%" height={240}>
                    <BarChart data={data.series || []} margin={{ top: 18, right: 12, bottom: 4, left: 0 }}>
                      <XAxis dataKey="label" tick={{ fontSize: 10, fill: 'var(--gray-600)' }} axisLine={false} tickLine={false} />
                      <YAxis hide />
                      <Tooltip content={<ChartTooltip />} />
                      <Bar dataKey="value" fill="var(--blue-600)" radius={[4, 4, 0, 0]}>
                        <LabelList dataKey="value" position="top" formatter={(value) => value ? formatCurrency(value) : ''} style={{ fontSize: 10, fill: 'var(--gray-600)' }} />
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                  <p className="text-xs text-muted">Obligations reported by USAspending in the selected period.</p>
                </div>
                <div>
                  <h3>Prime contracts by agency</h3>
                  {doughnut.length === 0 ? <p className="text-sm text-muted">No agency data.</p> : (
                    <div className={styles.agencyDistribution}>
                      <ResponsiveContainer width="100%" height={220}>
                        <PieChart>
                          <Tooltip content={<ChartTooltip formatLabel={(item) => item.name} formatValue={(item) => `${item.count} contract${item.count === 1 ? '' : 's'} · ${item.percentage.toFixed(1)}%`} />} />
                          <Pie data={doughnut} dataKey="count" nameKey="name" innerRadius={48} outerRadius={78} label={({ value }) => `${(total ? Number(value) / total * 100 : 0).toFixed(0)}%`} labelLine={false}>
                            {doughnut.map((item, index) => <Cell key={item.name} fill={CHART_COLORS[index % CHART_COLORS.length]} />)}
                          </Pie>
                        </PieChart>
                      </ResponsiveContainer>
                      <div className={styles.agencyTable}>{doughnut.map((item) => <div key={item.name} className={styles.agencyRow} title={`${item.count} prime contract${item.count === 1 ? '' : 's'} `}><span>{item.name}</span><strong>{item.percentage.toFixed(1)}%</strong></div>)}</div>
                    </div>
                  )}
                </div>
              </div>
              <p className={styles.source}>USAspending.gov · {data.cache === 'cache' ? 'cached' : 'live'} · Prime contracts only. Subaward history is not shown until recipient-level subaward filtering is verified.</p>
            </>}
    </section>
  )
}
