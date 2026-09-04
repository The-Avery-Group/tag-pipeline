import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Bar, BarChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { useExpiringContracts } from '@/hooks/useExpiringContracts'
import { useEntityEightA } from '@/hooks/useEntityEightA'
import CopyValue from '@/components/Common/CopyValue'
import { formatDate } from '@/utils/kpiHelpers'
import { resolveModifierWithCrmContacts } from '@/utils/modifierIdentity'
import { dateOnly, localDate, sbaProfileUrl } from '@/utils/opportunityDates'
import styles from './ExpiringContractDiscovery.module.css'

const C = {
  id: 'Contract Number / Notice ID',
  title: 'Project Title / Description*',
  department: 'Department*',
  agency: 'Agency*',
  office: 'Office*',
  value: 'Total Contract Value ($)*',
  phase: 'TAG Opportunity Phase',
  outlook: 'Opportunity Outlook',
  naics: 'NAICS Code*',
  endDate: 'Contract End Date*',
  incumbent: 'Incumbent (Company Name)',
  incumbentUEI: 'Incumbent (Company UEI)',
  classification: 'Contract Classification*',
  solicitation: 'Solicitation Number',
  vehicleNumber: 'Contract Vehicle Number',
  vehicle: 'Contract Vehicle',
  fiscalYear: 'Fiscal Year',
  setAside: 'Set- Aside*',
  priority: 'Priority',
  primeOrSub: 'Prime or Sub?',
  noticeType: 'Notice Type',
}

function compactMoney(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return 'Not available'
  if (Math.abs(number) >= 1_000_000_000) return `$${(number / 1_000_000_000).toFixed(1)}B`
  if (Math.abs(number) >= 1_000_000) return `$${(number / 1_000_000).toFixed(1)}M`
  if (Math.abs(number) >= 1_000) return `$${(number / 1_000).toFixed(0)}K`
  return number.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
}

function fullMoney(value) {
  const number = Number(value)
  return Number.isFinite(number)
    ? number.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 })
    : 'Not available'
}

function formatRefreshTime(value) {
  const date = value ? new Date(value) : null
  if (!date || Number.isNaN(date.getTime())) return ''
  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  })
}

function contractDate(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : new Date(value)
  const raw = String(value || '').slice(0, 10)
  const date = raw ? new Date(`${raw}T12:00:00`) : null
  return date && !Number.isNaN(date.getTime()) ? date : null
}

function emptyTimeline(now, { basis, grouping, months, year, quarter }) {
  const start = periodForDate(now, basis)
  if (!start) return []
  if (grouping === 'year') {
    const years = year ? [Number(year)] : Array.from({ length: Math.max(1, Math.ceil(months / 12)) }, (_, index) => start.year + index)
    return years.map((itemYear) => ({
      year: itemYear,
      key: String(itemYear),
      label: basis === 'fiscal' ? `FY${String(itemYear).slice(-2)}` : String(itemYear),
      fullLabel: basis === 'fiscal' ? `FY${itemYear}` : `Calendar ${itemYear}`,
      count: 0,
      value: 0,
    }))
  }
  if (year) {
    return [1, 2, 3, 4]
      .filter((itemQuarter) => quarter === 'all' || itemQuarter === Number(quarter))
      .map((itemQuarter) => ({ year: Number(year), quarter: itemQuarter, key: `${year}-Q${itemQuarter}`, label: basis === 'fiscal' ? `FY${String(year).slice(-2)} Q${itemQuarter}` : `${year} Q${itemQuarter}`, fullLabel: basis === 'fiscal' ? `FY${year} Q${itemQuarter}` : `Calendar ${year} Q${itemQuarter}`, count: 0, value: 0 }))
  }
  return Array.from({ length: Math.max(1, Math.ceil(months / 3)) }, (_, index) => {
    const offset = (start.quarter - 1) + index
    const itemYear = start.year + Math.floor(offset / 4)
    const itemQuarter = (offset % 4) + 1
    return { year: itemYear, quarter: itemQuarter, key: `${itemYear}-Q${itemQuarter}`, label: basis === 'fiscal' ? `FY${String(itemYear).slice(-2)} Q${itemQuarter}` : `${itemYear} Q${itemQuarter}`, fullLabel: basis === 'fiscal' ? `FY${itemYear} Q${itemQuarter}` : `Calendar ${itemYear} Q${itemQuarter}`, count: 0, value: 0 }
  }).filter((item) => quarter === 'all' || item.quarter === Number(quarter))
}

function periodForDate(value, basis = 'fiscal') {
  const date = contractDate(value)
  if (!date) return null
  const month = date.getMonth()
  if (basis === 'fiscal') {
    const year = month >= 9 ? date.getFullYear() + 1 : date.getFullYear()
    const quarter = Math.floor(((month + 3) % 12) / 3) + 1
    return { year, quarter, key: `${year}-Q${quarter}`, label: `FY${String(year).slice(-2)} Q${quarter}`, fullLabel: `FY${year} Q${quarter}` }
  }
  const year = date.getFullYear()
  const quarter = Math.floor(month / 3) + 1
  return { year, quarter, key: `${year}-Q${quarter}`, label: `${year} Q${quarter}`, fullLabel: `Calendar ${year} Q${quarter}` }
}

function expirationPeriod(value, basis = 'fiscal', grouping = 'quarter') {
  const period = periodForDate(value, basis)
  if (!period) return null
  return grouping === 'year'
    ? { ...period, key: String(period.year), label: basis === 'fiscal' ? `FY${String(period.year).slice(-2)}` : String(period.year), fullLabel: basis === 'fiscal' ? `FY${period.year}` : `Calendar ${period.year}` }
    : period
}

function addMonths(date, months) {
  const next = new Date(date)
  next.setMonth(next.getMonth() + months)
  return next
}

function labelForContract(contract) {
  return contract.title || contract.description || contract.piid || 'Untitled contract'
}

function vehicleName(contract) {
  return contract.vehicleResolution?.status === 'RESOLVED'
    ? String(contract.vehicleResolution.vehicleName || '').trim()
    : ''
}

const MARKET_EXPIRATION_BANDS = {
  '0-6': [0, 6],
  '6-12': [6, 12],
  '12-18': [12, 18],
  '18-24': [18, 24],
  '24+': [24, 60],
}

function groupMarketContracts(contracts, getLabel, limit = 8, metric = 'count') {
  const groups = new Map()
  contracts.forEach((contract) => {
    const label = String(getLabel(contract) || '').trim()
    if (!label) return
    const current = groups.get(label) || { label, count: 0, value: 0 }
    current.count += 1
    current.value += Number(contract.totalContractValue) || 0
    groups.set(label, current)
  })
  return [...groups.values()]
    .sort((left, right) => right[metric] - left[metric] || right.count - left.count || left.label.localeCompare(right.label))
    .slice(0, limit)
}

function MarketTooltip({ active, payload, metric = 'count', noun = 'contracts' }) {
  if (!active || !payload?.length) return null
  const item = payload[0].payload
  return <div className={styles.marketTooltip}><strong>{item.fullLabel || item.label}</strong><span>{metric === 'value' ? fullMoney(item.value) : `${item.count.toLocaleString()} ${noun}`}</span></div>
}

function marketAxisLines(value, maximumLength = 30) {
  const words = String(value || '').trim().split(/\s+/).filter(Boolean)
  if (!words.length) return ['']
  const lines = []
  words.forEach((word) => {
    const current = lines[lines.length - 1]
    if (!current || `${current} ${word}`.length > maximumLength) lines.push(word)
    else lines[lines.length - 1] = `${current} ${word}`
  })
  return lines
}

function MarketCategoryTick({ x, y, payload }) {
  const lines = marketAxisLines(payload?.value)
  const lineHeight = 11
  const firstLineOffset = -((lines.length - 1) * lineHeight) / 2
  return (
    <text x={x} y={y} textAnchor="end" fill="var(--gray-600)" fontSize={10}>
      {lines.map((line, index) => (
        <tspan key={`${line}-${index}`} x={x} dy={index === 0 ? firstLineOffset : lineHeight}>{line}</tspan>
      ))}
    </text>
  )
}

function MarketBarChart({ data, metric, horizontal = false, onSelect, noun }) {
  if (!data.length) return <div className={styles.chartEmpty}>No contracts match these filters.</div>
  const valueFormatter = (value) => metric === 'value' ? compactMoney(value) : Number(value).toLocaleString()
  const horizontalRowHeight = Math.max(34, ...data.map((item) => marketAxisLines(item.label).length * 13 + 16))
  return (
    <ResponsiveContainer width="100%" height={horizontal ? Math.max(230, data.length * horizontalRowHeight) : 280}>
      <BarChart data={data} layout={horizontal ? 'vertical' : 'horizontal'} margin={horizontal ? { top: 8, right: 46, bottom: 8, left: 14 } : { top: 12, right: 22, bottom: 20, left: 14 }}>
        {horizontal ? <><XAxis type="number" tickFormatter={valueFormatter} tick={{ fontSize: 10, fill: 'var(--gray-500)' }} axisLine={false} tickLine={false} /><YAxis type="category" dataKey="label" width={212} tick={<MarketCategoryTick />} axisLine={false} tickLine={false} interval={0} /></> : <><XAxis dataKey="label" height={38} tick={{ fontSize: 10, fill: 'var(--gray-600)' }} axisLine={false} tickLine={false} interval="preserveStartEnd" /><YAxis width={58} tickFormatter={valueFormatter} tick={{ fontSize: 10, fill: 'var(--gray-500)' }} axisLine={false} tickLine={false} allowDecimals={metric === 'value'} /></>}
        <Tooltip cursor={{ fill: 'var(--gray-50)' }} content={<MarketTooltip metric={metric} noun={noun} />} />
        <Bar dataKey={metric} fill="var(--blue-600)" radius={horizontal ? [0, 4, 4, 0] : [4, 4, 0, 0]} maxBarSize={horizontal ? 22 : 38} cursor={onSelect ? 'pointer' : 'default'} onClick={(entry) => onSelect?.(entry?.payload || entry)} />
      </BarChart>
    </ResponsiveContainer>
  )
}

function ChartMetricToggle({ value, onChange }) {
  return (
    <div className={styles.metricToggle} aria-label="Chart measure">
      <button type="button" className={value === 'count' ? styles.metricActive : ''} onClick={() => onChange('count')}>Count</button>
      <button type="button" className={value === 'value' ? styles.metricActive : ''} onClick={() => onChange('value')}>Value</button>
    </div>
  )
}

function MarketIntelligenceView({ contracts, loading, error, search, expanded, detailLoading, details, toggleDetails, onCountChange }) {
  const [filters, setFilters] = useState({ band: 'all', from: '', to: '', basis: 'fiscal', grouping: 'quarter', year: '', quarter: 'all', agency: 'all', vehicle: 'all', setAside: 'all', value: 'all', focus: '' })
  const [metrics, setMetrics] = useState({ timeline: 'count', vehicle: 'count', agency: 'count', setAside: 'count' })
  const expirationFilterRef = useRef(null)
  const secondaryFiltersRef = useRef(null)
  const updateFilter = (key, value) => setFilters((current) => ({ ...current, [key]: value, ...(key !== 'focus' ? { focus: '' } : {}) }))
  const toggleChartFilter = (key, value, clearedValue = 'all') => setFilters((current) => ({
    ...current,
    [key]: current[key] === value ? clearedValue : value,
    ...(key !== 'focus' ? { focus: '' } : {}),
  }))
  const updateMetric = (chart, value) => setMetrics((current) => ({ ...current, [chart]: value }))
  const now = useMemo(() => { const date = new Date(); date.setHours(0, 0, 0, 0); return date }, [])
  const baseContracts = useMemo(() => {
    const needle = String(search || '').trim().toLowerCase()
    const maximum = addMonths(now, 60)
    const bandBounds = MARKET_EXPIRATION_BANDS[filters.band]
    const customFrom = contractDate(filters.from)
    const customTo = contractDate(filters.to)
    return contracts.filter((contract) => {
      const end = contractDate(contract.ultimateCompletionDate)
      if (!end || end < now || end > maximum) return false
      if (bandBounds && (end < addMonths(now, bandBounds[0]) || end > addMonths(now, bandBounds[1]))) return false
      if (customFrom && end < customFrom) return false
      if (customTo && end > customTo) return false
      const period = periodForDate(end, filters.basis)
      if (filters.year && period?.year !== Number(filters.year)) return false
      if (filters.quarter !== 'all' && period?.quarter !== Number(filters.quarter)) return false
      if (filters.agency !== 'all' && (contract.agency || contract.department) !== filters.agency) return false
      if (filters.vehicle !== 'all' && vehicleName(contract) !== filters.vehicle) return false
      if (filters.setAside === '__not_specified__' && String(contract.setAside || '').trim()) return false
      if (!['all', '__not_specified__'].includes(filters.setAside) && String(contract.setAside || '') !== filters.setAside) return false
      const value = Number(contract.totalContractValue) || 0
      if (filters.value === 'under1m' && value >= 1_000_000) return false
      if (filters.value === '1m10m' && (value < 1_000_000 || value >= 10_000_000)) return false
      if (filters.value === '10m100m' && (value < 10_000_000 || value >= 100_000_000)) return false
      if (filters.value === 'over100m' && value < 100_000_000) return false
      return !needle || Object.values(contract).some((item) => String(item || '').toLowerCase().includes(needle))
    })
  }, [contracts, filters.agency, filters.band, filters.basis, filters.from, filters.quarter, filters.setAside, filters.to, filters.value, filters.vehicle, filters.year, now, search])
  const years = useMemo(() => [...new Set(contracts.map((contract) => periodForDate(contract.ultimateCompletionDate, filters.basis)?.year).filter(Boolean))].sort((a, b) => a - b), [contracts, filters.basis])
  const agencyOptions = useMemo(() => [...new Set(contracts.map((contract) => contract.agency || contract.department).filter(Boolean))].sort(), [contracts])
  const vehicleOptions = useMemo(() => [...new Set(contracts.filter((contract) => contract.referencedIdvPiid).map(vehicleName).filter(Boolean))].sort(), [contracts])
  const setAsideOptions = useMemo(() => [...new Set(contracts.map((contract) => String(contract.setAside || '')).filter(Boolean))].sort(), [contracts])
  const timelineWindow = useMemo(() => {
    const bounds = MARKET_EXPIRATION_BANDS[filters.band] || [0, 60]
    const start = contractDate(filters.from) || addMonths(now, bounds[0])
    const end = contractDate(filters.to) || addMonths(now, bounds[1])
    const months = Math.max(3, ((end.getFullYear() - start.getFullYear()) * 12) + end.getMonth() - start.getMonth() + 1)
    return { start, months }
  }, [filters.band, filters.from, filters.to, now])
  const timeline = useMemo(() => {
    const groups = new Map(emptyTimeline(timelineWindow.start, { basis: filters.basis, grouping: filters.grouping, months: timelineWindow.months, year: filters.year, quarter: filters.quarter }).map((item) => [item.key, item]))
    baseContracts.forEach((contract) => {
      const period = expirationPeriod(contract.ultimateCompletionDate, filters.basis, filters.grouping)
      if (!period) return
      if (!groups.has(period.key)) return
      const current = groups.get(period.key) || { ...period, count: 0, value: 0 }
      current.count += 1
      current.value += Number(contract.totalContractValue) || 0
      groups.set(period.key, current)
    })
    return [...groups.values()].sort((left, right) => left.year - right.year || (left.quarter || 0) - (right.quarter || 0))
  }, [baseContracts, filters.basis, filters.grouping, filters.quarter, filters.year, timelineWindow])
  const visibleContracts = useMemo(() => filters.focus ? baseContracts.filter((contract) => expirationPeriod(contract.ultimateCompletionDate, filters.basis, filters.grouping)?.key === filters.focus) : baseContracts, [baseContracts, filters.basis, filters.focus, filters.grouping])
  const totalValue = visibleContracts.reduce((sum, contract) => sum + (Number(contract.totalContractValue) || 0), 0)
  const agenciesRepresented = new Set(visibleContracts.map((contract) => contract.agency || contract.department).filter(Boolean)).size
  const actualIdvs = [...new Set(visibleContracts.map((contract) => String(contract.referencedIdvPiid || '').trim()).filter(Boolean))]
  const resolvedIdvs = new Set(visibleContracts.filter((contract) => contract.referencedIdvPiid && vehicleName(contract)).map((contract) => String(contract.referencedIdvPiid).trim())).size
  const unresolvedContracts = visibleContracts.filter((contract) => contract.referencedIdvPiid && !vehicleName(contract))
  const vehicleData = groupMarketContracts(visibleContracts.filter((contract) => contract.referencedIdvPiid && vehicleName(contract)), vehicleName, 12, metrics.vehicle)
  const agencyData = groupMarketContracts(visibleContracts, (contract) => contract.agency || contract.department, 12, metrics.agency)
  const setAsideData = groupMarketContracts(visibleContracts, (contract) => contract.setAside || 'Not specified', 10, metrics.setAside)
  const clearFilters = () => setFilters({ band: 'all', from: '', to: '', basis: 'fiscal', grouping: 'quarter', year: '', quarter: 'all', agency: 'all', vehicle: 'all', setAside: 'all', value: 'all', focus: '' })
  const expirationLabel = filters.from || filters.to
    ? `${filters.from || 'Today'} – ${filters.to || '5 years'}`
    : filters.year
      ? `${filters.basis === 'fiscal' ? 'FY' : ''}${filters.year}${filters.quarter !== 'all' ? ` Q${filters.quarter}` : ''}`
      : filters.band === 'all' ? 'All five years' : `${filters.band} months`

  useEffect(() => {
    const closeOpenFilters = (event) => {
      ;[expirationFilterRef, secondaryFiltersRef].forEach((filterRef) => {
        const element = filterRef.current
        if (element?.open && !element.contains(event.target)) element.removeAttribute('open')
      })
    }
    document.addEventListener('pointerdown', closeOpenFilters)
    return () => document.removeEventListener('pointerdown', closeOpenFilters)
  }, [])

  useEffect(() => onCountChange?.(visibleContracts.length), [onCountChange, visibleContracts.length])

  return (
    <div className={styles.marketWorkspace}>
      <div className={styles.marketHeading}><div><h2>Market intelligence</h2><p>Acquisition outlook based on TAG’s quarterly SAM.gov expiring-contract dataset.</p></div></div>
      <div className={styles.compactFilters}>
        <details ref={expirationFilterRef} className={styles.expirationFilter}>
          <summary>Expiration <strong>{expirationLabel}</strong><span>⌄</span></summary>
          <div className={styles.expirationPanel}>
            <div className={styles.bandPicker}>
              {['all', '0-6', '6-12', '12-18', '18-24', '24+'].map((band) => <button type="button" key={band} className={filters.band === band ? styles.bandActive : ''} onClick={() => setFilters((current) => ({ ...current, band, from: '', to: '', focus: '' }))}>{band === 'all' ? 'All' : `${band} months`}</button>)}
            </div>
            <div className={styles.exactDateRow}><label><span>From date</span><input type="date" value={filters.from} onChange={(event) => setFilters((current) => ({ ...current, from: event.target.value, band: 'all', focus: '' }))} /></label><label><span>To date</span><input type="date" value={filters.to} onChange={(event) => setFilters((current) => ({ ...current, to: event.target.value, band: 'all', focus: '' }))} /></label></div>
            <div className={styles.periodFilterRow}>
              <label><span>Year basis</span><select value={filters.basis} onChange={(event) => updateFilter('basis', event.target.value)}><option value="fiscal">Federal fiscal</option><option value="calendar">Calendar</option></select></label>
              <label><span>Exact year</span><select value={filters.year} onChange={(event) => updateFilter('year', event.target.value)}><option value="">All years</option>{years.map((year) => <option key={year} value={year}>{filters.basis === 'fiscal' ? `FY${year}` : year}</option>)}</select></label>
              <label><span>Quarter</span><select value={filters.quarter} onChange={(event) => updateFilter('quarter', event.target.value)}><option value="all">All quarters</option>{[1, 2, 3, 4].map((quarter) => <option key={quarter} value={quarter}>Q{quarter}</option>)}</select></label>
              <label><span>Chart grouping</span><select value={filters.grouping} onChange={(event) => updateFilter('grouping', event.target.value)}><option value="quarter">Quarter</option><option value="year">Year</option></select></label>
            </div>
          </div>
        </details>
        <label className={styles.compactSelect}><span>Agency</span><select value={filters.agency} onChange={(event) => updateFilter('agency', event.target.value)}><option value="all">All agencies</option>{agencyOptions.map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
        <label className={styles.compactSelect}><span>Vehicle</span><select value={filters.vehicle} onChange={(event) => updateFilter('vehicle', event.target.value)}><option value="all">All contract vehicles</option>{vehicleOptions.map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
        <details ref={secondaryFiltersRef} className={styles.secondaryFilters}><summary>More <span>⌄</span></summary><div><label><span>Set-aside</span><select value={filters.setAside} onChange={(event) => updateFilter('setAside', event.target.value)}><option value="all">All set-asides</option><option value="__not_specified__">Not specified</option>{setAsideOptions.map((value) => <option key={value} value={value}>{value}</option>)}</select></label><label><span>Contract value</span><select value={filters.value} onChange={(event) => updateFilter('value', event.target.value)}><option value="all">Any value</option><option value="under1m">Under $1M</option><option value="1m10m">$1M–$10M</option><option value="10m100m">$10M–$100M</option><option value="over100m">$100M+</option></select></label></div></details>
        <button type="button" className={styles.clearMarketFilters} onClick={clearFilters}>Reset</button>
      </div>
      {loading ? <div className={styles.loading}>Loading market intelligence…</div> : error ? <div className={styles.errorCallout}><span>{error}</span></div> : <>
        <div className={styles.marketKpis}><article><span>Expiring contracts</span><strong>{visibleContracts.length.toLocaleString()}</strong><small>{filters.focus ? `Filtered to ${timeline.find((item) => item.key === filters.focus)?.fullLabel || filters.focus}` : 'Within the selected outlook'}</small></article><article><span>Potential contract value</span><strong>{compactMoney(totalValue)}</strong><small title={fullMoney(totalValue)}>{fullMoney(totalValue)}</small></article><article><span>Agencies represented</span><strong>{agenciesRepresented.toLocaleString()}</strong><small>Contracting agencies in view</small></article><article><span>Referenced IDVs resolved</span><strong>{actualIdvs.length ? `${Math.round((resolvedIdvs / actualIdvs.length) * 100)}%` : '—'}</strong><small>{resolvedIdvs} of {actualIdvs.length} referenced IDVs</small></article></div>
        {filters.focus && <div className={styles.focusNotice}><span>Dashboard filtered to <strong>{timeline.find((item) => item.key === filters.focus)?.fullLabel || filters.focus}</strong>.</span><button type="button" onClick={() => updateFilter('focus', '')}>Clear period</button></div>}
        {unresolvedContracts.length > 0 && <div className={styles.warningCallout}><div><strong>{new Set(unresolvedContracts.map((contract) => contract.referencedIdvPiid)).size} referenced IDVs need a vehicle rule</strong><span>These contracts remain in totals but are excluded from named vehicle usage.</span></div></div>}
        <section className={`${styles.marketCard} ${styles.timelineCard}`}><div className={styles.marketCardHeader}><div><h3>Expiring contracts outlook</h3><p>{filters.grouping === 'quarter' ? 'Quarterly' : 'Yearly'} view · click a bar to filter the page</p></div><ChartMetricToggle value={metrics.timeline} onChange={(value) => updateMetric('timeline', value)} /></div><MarketBarChart data={timeline} metric={metrics.timeline} onSelect={(item) => toggleChartFilter('focus', item.key, '')} /></section>
        <section className={styles.marketCard}><div className={styles.marketCardHeader}><div><h3>Contract vehicle usage</h3><p>Resolved vehicles from contracts with a referenced IDV PIID</p></div><ChartMetricToggle value={metrics.vehicle} onChange={(value) => updateMetric('vehicle', value)} /></div><MarketBarChart data={vehicleData} metric={metrics.vehicle} horizontal noun="contracts" onSelect={(item) => toggleChartFilter('vehicle', item.label)} /></section>
        <section className={styles.marketCard}><div className={styles.marketCardHeader}><div><h3>Agency outlook</h3><p>{filters.basis === 'fiscal' ? 'Federal fiscal' : 'Calendar'} {filters.grouping} view</p></div><ChartMetricToggle value={metrics.agency} onChange={(value) => updateMetric('agency', value)} /></div><MarketBarChart data={agencyData} metric={metrics.agency} horizontal noun="contracts" onSelect={(item) => toggleChartFilter('agency', item.label)} /></section>
        <section className={styles.marketCard}><div className={styles.marketCardHeader}><div><h3>Set-aside distribution</h3><p>Acquisition restrictions represented in the current view</p></div><ChartMetricToggle value={metrics.setAside} onChange={(value) => updateMetric('setAside', value)} /></div><MarketBarChart data={setAsideData} metric={metrics.setAside} horizontal noun="contracts" onSelect={(item) => toggleChartFilter('setAside', item.label === 'Not specified' ? '__not_specified__' : item.label)} /></section>
        <details className={styles.marketTableCard}><summary className={styles.contractRegisterSummary}><div><h3>Underlying contracts</h3><p>Open the filtered contract register</p></div><strong>{visibleContracts.length.toLocaleString()} contract{visibleContracts.length === 1 ? '' : 's'}</strong><span>⌄</span></summary>{!visibleContracts.length ? <div className={styles.empty}>No contracts match the selected market filters.</div> : <div className={styles.marketTableScroll}><table className="data-table"><thead><tr><th>Contract</th><th>Agency / office</th><th>Incumbent</th><th>Expiration</th><th>Value</th><th>Vehicle</th><th>PSC / NAICS</th><th>Set-aside</th><th aria-label="Contract details" /></tr></thead><tbody>{visibleContracts.map((contract) => {
          const isOpen = expanded.has(contract.familyKey)
          const detail = details[contract.familyKey] || contract
          return [<tr key={contract.familyKey} className={styles.marketContractRow} onClick={() => toggleDetails(contract)}><td><button type="button" className={styles.contractTitle}>{labelForContract(contract)}</button><small>{contract.piid}</small></td><td><span>{contract.agency || contract.department || 'Not available'}</span><small>{contract.office || ''}</small></td><td>{contract.incumbentName || 'Not available'}</td><td>{formatDate(contract.ultimateCompletionDate)}</td><td title={fullMoney(contract.totalContractValue)}>{compactMoney(contract.totalContractValue)}</td><td>{vehicleName(contract) || (contract.referencedIdvPiid ? 'Needs review' : '')}</td><td><span>{contract.pscCode ? `PSC ${contract.pscCode}` : 'No PSC'}</span><small>{contract.naicsCode ? `NAICS ${contract.naicsCode}` : ''}</small></td><td>{contract.setAside || 'Not specified'}</td><td><button type="button" className={styles.expandButton} aria-label={`${isOpen ? 'Collapse' : 'Expand'} ${labelForContract(contract)}`} aria-expanded={isOpen}>{isOpen ? '⌃' : '⌄'}</button></td></tr>, isOpen && <tr key={`${contract.familyKey}-market-detail`} className={styles.detailRow}><td colSpan="9">{detailLoading.has(contract.familyKey) ? <div className={styles.loading}>Loading saved contract details…</div> : <div className={styles.marketDetailGrid}><DetailField label="Contract number" value={detail.piid} /><DetailField label="Description" value={detail.description || detail.title} /><DetailField label="Department" value={detail.department} /><DetailField label="Agency" value={detail.agency} /><DetailField label="Office" value={detail.office} /><DetailField label="Incumbent" value={detail.incumbentName} /><DetailField label="Referenced IDV" value={detail.referencedIdvPiid} /><DetailField label="Contract vehicle" value={vehicleName(detail)} /><DetailField label="PSC" value={[detail.pscCode, detail.pscDescription].filter(Boolean).join(' · ')} /><DetailField label="NAICS" value={detail.naicsCode} /><DetailField label="Set-aside" value={detail.setAside} /><DetailField label="Ultimate completion" value={detail.ultimateCompletionDate ? formatDate(detail.ultimateCompletionDate) : null} /></div>}</td></tr>]
        })}</tbody></table></div>}</details>
      </>}
    </div>
  )
}

function DetailField({ label, value, link }) {
  const displayValue = value || 'Not available'
  return (
    <div className={styles.detailField}>
      <span>{label}</span>
      {link && value
        ? <CopyValue value={value} label={label}><a href={link} target="_blank" rel="noreferrer">{value}</a></CopyValue>
        : value ? <CopyValue value={value} label={label}><strong>{displayValue}</strong></CopyValue> : <strong>{displayValue}</strong>}
    </div>
  )
}

function CompactEightAStatus({ uei, contractEndDate }) {
  const normalizedUEI = String(uei || '').trim().toUpperCase()
  const validUEI = /^[A-Z0-9]{12}$/.test(normalizedUEI)
  const { data, loading, error } = useEntityEightA(validUEI ? normalizedUEI : '')

  if (!validUEI) return <div className={`${styles.eightAStatus} ${styles.eightANeutral}`}>8(a) check needs a valid incumbent UEI.</div>
  if (loading) return <div className={`${styles.eightAStatus} ${styles.eightANeutral}`}>Checking 8(a) status…</div>

  const sbaLink = sbaProfileUrl(data, normalizedUEI)
  const exitDate = data?.eightA?.exitDate
  if (error || !exitDate) {
    const message = error
      ? '8(a) status is temporarily unavailable.'
      : data?.eightA
        ? 'No 8(a) exit date was returned.'
        : 'No active 8(a) record was returned.'
    return (
      <div className={`${styles.eightAStatus} ${styles.eightANeutral}`} title={error || undefined}>
        <span>{message}</span>
        <a href={sbaLink} target="_blank" rel="noreferrer">Verify on SBA</a>
      </div>
    )
  }

  const exit = localDate(exitDate)
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const sixMonthsFromNow = new Date(today)
  sixMonthsFromNow.setMonth(sixMonthsFromNow.getMonth() + 6)
  const contractEnd = localDate(contractEndDate)
  const exited = exit < today
  const exitsBeforeContractEnd = !exited && !Number.isNaN(contractEnd.getTime()) && exit < contractEnd
  const tone = exited ? styles.eightAGreen : exit <= sixMonthsFromNow ? styles.eightAAmber : styles.eightARed

  return (
    <div className={`${styles.eightAStatus} ${tone}`}>
      <span>8(a) exit <strong>{formatDate(dateOnly(exitDate))}</strong>{exited ? ' · Past date' : exitsBeforeContractEnd ? ' · Before contract end' : ''}</span>
      <small>SBA Entity Management API</small>
      <a href={sbaLink} target="_blank" rel="noreferrer">Verify on SBA</a>
    </div>
  )
}

function ModifierIdentity({ resolution, choice = '', onChoose }) {
  if (!resolution?.raw) return <span className={styles.muted}>Not available</span>
  if (resolution.status === 'system') {
    return <span>{resolution.raw}<small className={styles.matchSource}>System account</small></span>
  }
  if (resolution.status === 'matched') {
    const match = resolution.matches[0]
    return (
      <span>
        {match.name || resolution.raw}
        <small className={styles.rawIdentifier}>{resolution.raw}</small>
        {match.sourceLink
          ? <a className={styles.matchSource} href={match.sourceLink} target="_blank" rel="noreferrer">Matched from {match.sourceLabel}</a>
          : <small className={styles.matchSource}>Matched from {match.sourceLabel}</small>}
      </span>
    )
  }
  if (resolution.status === 'multiple') {
    const selected = resolution.matches[Number(choice)]
    return (
      <div className={styles.matchChoices}>
        <span>{selected?.name || resolution.raw}</span>
        <small className={styles.rawIdentifier}>{resolution.raw} · {resolution.matches.length} possible matches</small>
        <select value={choice} onChange={(event) => onChoose?.(event.target.value)} aria-label={`Resolve ${resolution.raw}`}>
          <option value="">Choose a match</option>
          {resolution.matches.map((match, index) => <option key={`${match.email}-${match.noticeId || match.contactId || index}`} value={String(index)}>{match.name || match.email} · {match.sourceLabel}</option>)}
        </select>
        {selected?.sourceLink
          ? <a className={styles.matchSource} href={selected.sourceLink} target="_blank" rel="noreferrer">Matched from {selected.sourceLabel}</a>
          : selected && <small className={styles.matchSource}>Matched from {selected.sourceLabel}</small>}
      </div>
    )
  }
  return <span>{resolution.raw}<small className={styles.matchSource}>No public name match found</small></span>
}

export default function ExpiringContractDiscovery({ pipeline, contacts = [], add, openOpportunity, pipelineView, search, toast, view = 'pipeline', onViewChange, onMarketCountChange }) {
  const navigate = useNavigate()
  const [range, setRange] = useState('6-12')
  const [selectedAgencyIds, setSelectedAgencyIds] = useState([])
  const [agencyMenuOpen, setAgencyMenuOpen] = useState(false)
  const [agencySearch, setAgencySearch] = useState('')
  const [agencyMatches, setAgencyMatches] = useState([])
  const [agencyResolving, setAgencyResolving] = useState(false)
  const [agencyResolveError, setAgencyResolveError] = useState('')
  const [classification, setClassification] = useState('all')
  const [setAside, setSetAside] = useState('all')
  const [showHidden, setShowHidden] = useState(false)
  const [expanded, setExpanded] = useState(new Set())
  const [details, setDetails] = useState({})
  const [detailLoading, setDetailLoading] = useState(new Set())
  const [addingKey, setAddingKey] = useState('')
  const [modifierChoices, setModifierChoices] = useState({})
  const [refreshStarting, setRefreshStarting] = useState(false)
  const [visibilityKey, setVisibilityKey] = useState('')
  const [vehicleRuleSaving, setVehicleRuleSaving] = useState('')
  const refreshStartingRef = useRef(false)
  const agencyControlRef = useRef(null)
  const {
    config,
    contracts,
    hiddenCount,
    status,
    loading,
    error,
    refresh,
    loadDetail,
    resolveAgencies,
    saveAgency,
    removeAgency,
    setContractHidden,
    saveVehicleRule,
  } = useExpiringContracts(view === 'intelligence' ? '0-60' : range, selectedAgencyIds, showHidden)

  const agencies = config.agencies || []
  const effectiveAgencyIds = selectedAgencyIds.length ? selectedAgencyIds : agencies.map((agency) => agency.id)
  const selectedAgencies = agencies.filter((agency) => effectiveAgencyIds.includes(agency.id))
  const agencyPickerLabel = selectedAgencies.length === agencies.length
    ? 'All target agencies'
    : selectedAgencies.length <= 2
      ? selectedAgencies.map((agency) => agency.label).join(', ') || 'No agencies selected'
      : `${selectedAgencies.slice(0, 2).map((agency) => agency.label).join(', ')} + ${selectedAgencies.length - 2} more`
  const pipelineById = useMemo(() => new Map(pipeline.map((opportunity) => [String(opportunity[C.id] || '').trim().toUpperCase(), opportunity])), [pipeline])
  const classifications = useMemo(() => [...new Set(
    contracts.map((contract) => String(contract.awardType || '').trim()).filter(Boolean),
  )].sort((left, right) => left.localeCompare(right)), [contracts])
  const setAsides = useMemo(() => [...new Set(
    contracts.map((contract) => String(contract.setAside || '').trim()).filter(Boolean),
  )].sort((left, right) => left.localeCompare(right)), [contracts])
  const visibleContracts = useMemo(() => {
    const needle = String(search || '').trim().toLowerCase()
    return contracts.filter((contract) => {
      if (classification !== 'all' && String(contract.awardType || '').trim() !== classification) return false
      if (setAside !== 'all' && String(contract.setAside || '').trim() !== setAside) return false
      if (!needle) return true
      return Object.values(contract).some((value) => String(value || '').toLowerCase().includes(needle))
    })
  }, [classification, contracts, search, setAside])

  useEffect(() => {
    if (classification !== 'all' && !classifications.includes(classification)) setClassification('all')
  }, [classification, classifications])

  useEffect(() => {
    if (setAside !== 'all' && !setAsides.includes(setAside)) setSetAside('all')
  }, [setAside, setAsides])

  useEffect(() => {
    if (!agencyMenuOpen) return undefined
    const closeOnOutside = (event) => {
      if (!agencyControlRef.current?.contains(event.target)) setAgencyMenuOpen(false)
    }
    const closeOnEscape = (event) => {
      if (event.key === 'Escape') setAgencyMenuOpen(false)
    }
    document.addEventListener('pointerdown', closeOnOutside)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOnOutside)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [agencyMenuOpen])

  const toggleAgency = (id) => {
    setSelectedAgencyIds((current) => {
      const base = current.length ? current : agencies.map((agency) => agency.id)
      return base.includes(id) ? base.filter((value) => value !== id) : [...base, id]
    })
  }

  const runRefresh = async () => {
    if (refreshStartingRef.current || ['queued', 'running'].includes(status.status)) return
    refreshStartingRef.current = true
    setRefreshStarting(true)
    try {
      await refresh(selectedAgencies.length ? selectedAgencies : agencies.filter((agency) => !agency.custom))
      toast?.success('Expiring contract refresh started')
    } catch (nextError) {
      toast?.error(`Could not start refresh: ${nextError.message}`)
    } finally {
      refreshStartingRef.current = false
      setRefreshStarting(false)
    }
  }

  const searchAgencies = async () => {
    const query = agencySearch.trim()
    if (query.length < 2 || agencyResolving) return
    setAgencyResolving(true)
    setAgencyResolveError('')
    try {
      const matches = await resolveAgencies(query)
      setAgencyMatches(matches)
      if (!matches.length) setAgencyResolveError('No active SAM department or subagency matched this search.')
    } catch (nextError) {
      setAgencyMatches([])
      setAgencyResolveError(nextError.message)
    } finally {
      setAgencyResolving(false)
    }
  }

  const addResolvedAgency = async (agency) => {
    try {
      if (agency.saved) {
        const savedId = agency.savedId || agency.id
        setSelectedAgencyIds((current) => [...new Set([...(current.length ? current : agencies.map((item) => item.id)), savedId])])
        setAgencySearch('')
        setAgencyMatches([])
        setAgencyResolveError('')
        return
      }
      const previousIds = effectiveAgencyIds
      const nextAgencies = await saveAgency(agency)
      const savedAgency = nextAgencies.find((item) => item.organizationId && item.organizationId === agency.organizationId) || agency
      setSelectedAgencyIds([...new Set([...previousIds, savedAgency.id])].filter((id) => nextAgencies.some((item) => item.id === id)))
      setAgencySearch('')
      setAgencyMatches([])
      setAgencyResolveError('')
      toast?.success(`${agency.label} added to target agencies`)
    } catch (nextError) {
      toast?.error(`Agency could not be added: ${nextError.message}`)
    }
  }

  const removeResolvedAgency = async (agency) => {
    try {
      await removeAgency(agency.id)
      setSelectedAgencyIds((current) => current.filter((id) => id !== agency.id))
      toast?.success(`${agency.label} removed from target agencies`)
    } catch (nextError) {
      toast?.error(`Agency could not be removed: ${nextError.message}`)
    }
  }

  const toggleDetails = async (contract) => {
    const isOpen = expanded.has(contract.familyKey)
    setExpanded((current) => {
      const next = new Set(current)
      isOpen ? next.delete(contract.familyKey) : next.add(contract.familyKey)
      return next
    })
    if (isOpen || details[contract.familyKey]) return
    setDetailLoading((current) => new Set(current).add(contract.familyKey))
    try {
      const detail = await loadDetail(contract)
      setDetails((current) => ({ ...current, [contract.familyKey]: detail }))
    } catch (nextError) {
      toast?.error(`Contract details could not load: ${nextError.message}`)
    } finally {
      setDetailLoading((current) => {
        const next = new Set(current)
        next.delete(contract.familyKey)
        return next
      })
    }
  }

  const handleAdd = async (contract) => {
    if (addingKey) return
    setAddingKey(contract.familyKey)
    try {
      await add({
        [C.id]: contract.piid,
        [C.title]: contract.title || contract.description || contract.piid,
        [C.department]: contract.department || '',
        [C.agency]: contract.agency || '',
        [C.office]: contract.office || '',
        [C.value]: contract.totalContractValue ?? '',
        [C.phase]: 'Identified',
        [C.outlook]: 'Expiring',
        [C.naics]: contract.naicsCode || '',
        [C.endDate]: String(contract.ultimateCompletionDate || '').slice(0, 10),
        [C.incumbent]: contract.incumbentName || '',
        [C.incumbentUEI]: contract.incumbentUEI || '',
        [C.classification]: contract.awardType || '',
        [C.solicitation]: contract.solicitationNumber || '',
        [C.vehicleNumber]: contract.referencedIdvPiid || '',
        [C.vehicle]: contract.vehicleResolution?.status === 'RESOLVED' ? contract.vehicleResolution.vehicleName : '',
        [C.fiscalYear]: contract.fiscalYear || '',
        [C.setAside]: contract.setAside || '-',
        [C.priority]: 'Warm',
        [C.primeOrSub]: 'Prime',
        [C.noticeType]: '',
      })
      toast?.success('Contract added to the pipeline')
    } catch (nextError) {
      toast?.error(`Could not add contract: ${nextError.message}`)
    } finally {
      setAddingKey('')
    }
  }

  const addExactVehicleRule = async (contract) => {
    const identifier = contract.vehicleResolution?.referencedIdvPiid || contract.referencedIdvPiid
    if (!identifier || vehicleRuleSaving) return
    const vehicleName = window.prompt(`Contract vehicle name for ${identifier}`)?.trim()
    if (!vehicleName) return
    setVehicleRuleSaving(contract.familyKey)
    try {
      await saveVehicleRule({
        AGENCY: contract.department || contract.agency || '',
        VEHICLE_NAME: vehicleName,
        MATCH_MODE: 'FULL_PIID',
        FULL_PIID_RULE_TYPE: 'EXACT',
        FULL_PIID_RULE: identifier,
        PRIORITY: 500,
        CONFIDENCE: 'MANUAL',
        ENABLED: 'Yes',
        SOURCE: 'CRM user review',
        NOTES: `Added while reviewing expiring contract ${contract.piid || ''}`,
      })
      toast?.success(`${identifier} will resolve as ${vehicleName}`)
    } catch (nextError) {
      toast?.error(`Vehicle rule could not be saved: ${nextError.message}`)
    } finally {
      setVehicleRuleSaving('')
    }
  }

  const changeContractVisibility = async (contract, hidden, { quiet = false } = {}) => {
    if (visibilityKey) return
    setVisibilityKey(contract.familyKey)
    try {
      await setContractHidden(contract.familyKey, hidden)
      if (!quiet && hidden) {
        toast?.success('Contract hidden', {
          action: {
            label: 'Undo',
            onClick: () => changeContractVisibility(contract, false, { quiet: true }),
          },
        })
      } else if (!quiet) {
        toast?.success('Contract restored')
      }
    } catch (nextError) {
      toast?.error(`Contract visibility could not be changed: ${nextError.message}`)
    } finally {
      setVisibilityKey('')
    }
  }

  const progress = status.currentPages
    ? Math.min(99, Math.round(((status.agencyIndex + (status.currentPage / status.currentPages)) / Math.max(1, status.agencyTotal)) * 100))
    : Math.min(95, Math.round((status.agencyIndex / Math.max(1, status.agencyTotal)) * 100))

  return (
    <div className={styles.workspace}>
      <div className={styles.viewTabs} role="tablist" aria-label="Expiring contract views">
        <button type="button" role="tab" aria-selected={view === 'pipeline'} className={view === 'pipeline' ? styles.activeView : ''} onClick={() => onViewChange?.('pipeline')}>Pipeline contracts</button>
        <button type="button" role="tab" aria-selected={view === 'discover'} className={view === 'discover' ? styles.activeView : ''} onClick={() => onViewChange?.('discover')}>Discover from SAM.gov</button>
        <button type="button" role="tab" aria-selected={view === 'intelligence'} className={view === 'intelligence' ? styles.activeView : ''} onClick={() => onViewChange?.('intelligence')}>Market Intelligence</button>
      </div>

      {view === 'pipeline' ? pipelineView : view === 'intelligence' ? (
        <MarketIntelligenceView contracts={contracts} loading={loading} error={error} search={search} expanded={expanded} detailLoading={detailLoading} details={details} toggleDetails={toggleDetails} onCountChange={onMarketCountChange} />
      ) : (
        <>
          <div className={styles.controls}>
            <label>
              <span>Expiration range</span>
              <select value={range} onChange={(event) => setRange(event.target.value)}>
                <option value="6-12">6 to 12 months</option>
                <option value="12-18">12 to 18 months</option>
                <option value="18-24">18 to 24 months</option>
              </select>
            </label>
            <div className={styles.agencyControl} ref={agencyControlRef}>
              <span>Agencies to show</span>
              <button
                type="button"
                className={styles.agencyPicker}
                aria-expanded={agencyMenuOpen}
                title="Filters the contracts shown below. A manual refresh updates only the selected agencies."
                onClick={() => setAgencyMenuOpen((current) => !current)}
              >
                <span>{agencyPickerLabel}</span>
                <span>⌄</span>
              </button>
              {agencyMenuOpen && (
                <div className={styles.agencyMenu}>
                  <p className={styles.agencyHint}>Choose which agencies appear below. Refresh uses this same selection.</p>
                  {agencies.map((agency) => (
                    <div className={styles.agencyOption} key={agency.id}>
                      <label>
                        <input type="checkbox" checked={effectiveAgencyIds.includes(agency.id)} onChange={() => toggleAgency(agency.id)} />
                        <span>{agency.label}</span>
                        <small>{[agency.agencyCode, agency.custom ? 'Added' : ''].filter(Boolean).join(' · ') || 'Name fallback'}</small>
                      </label>
                      {agency.custom && <button type="button" className={styles.removeAgency} title={`Remove ${agency.label}`} aria-label={`Remove ${agency.label}`} onClick={() => removeResolvedAgency(agency)}>×</button>}
                    </div>
                  ))}
                  <div className={styles.agencyResolver}>
                    <span>Add another SAM agency</span>
                    <div>
                      <input value={agencySearch} onChange={(event) => setAgencySearch(event.target.value)} placeholder="Search official agency name or acronym" onKeyDown={(event) => { if (event.key === 'Enter') searchAgencies() }} />
                      <button type="button" onClick={searchAgencies} disabled={agencyResolving || agencySearch.trim().length < 2}>{agencyResolving ? 'Searching…' : 'Search'}</button>
                    </div>
                    {agencyResolveError && <small className={styles.agencyResolveError}>{agencyResolveError}</small>}
                    {agencyMatches.length > 0 && <div className={styles.agencyMatches}>
                      {agencyMatches.map((agency) => (
                        <button type="button" key={`${agency.id}-${agency.savedId || ''}`} onClick={() => addResolvedAgency(agency)}>
                          <strong>{agency.label}</strong>
                          <span>{agency.tier === 'department' ? 'Department' : 'Subagency'}{agency.agencyCode ? ` · ${agency.agencyCode}` : ''}{agency.saved ? ' · Already added' : ''}</span>
                          {agency.parentName && <small>{agency.parentName}</small>}
                        </button>
                      ))}
                    </div>}
                  </div>
                </div>
              )}
            </div>
            <label>
              <span>Contract classification</span>
              <select value={classification} onChange={(event) => setClassification(event.target.value)}>
                <option value="all">All classifications</option>
                {classifications.map((value) => <option key={value} value={value}>{value}</option>)}
              </select>
            </label>
            <label>
              <span>Set-aside</span>
              <select value={setAside} onChange={(event) => setSetAside(event.target.value)}>
                <option value="all">All set-asides</option>
                {setAsides.map((value) => <option key={value} value={value}>{value}</option>)}
              </select>
            </label>
            <button type="button" className={`${styles.hiddenToggle} ${showHidden ? styles.hiddenToggleActive : ''}`} onClick={() => setShowHidden((current) => !current)}>
              {showHidden ? 'Hide hidden' : `Show hidden${hiddenCount ? ` (${hiddenCount})` : ''}`}
            </button>
            <button type="button" className={`btn btn-primary ${styles.refreshButton}`} onClick={runRefresh} disabled={refreshStarting || ['queued', 'running'].includes(status.status)}>
              {refreshStarting ? 'Starting…' : ['queued', 'running'].includes(status.status) ? 'Refreshing…' : 'Refresh contracts'}
            </button>
          </div>

          {['queued', 'running'].includes(status.status) && (
            <div className={styles.progressPanel}>
              <div><strong>Refreshing expiring contracts</strong><span>{status.currentAgency || 'Preparing'}{status.currentPages ? ` · page ${status.currentPage} of ${status.currentPages}` : ''}</span></div>
              <div className={styles.progressTrack}><span style={{ width: `${progress}%` }} /></div>
            </div>
          )}

          {status.status === 'error' && (
            <div className={styles.errorCallout}>
              <div><strong>Expiring contract refresh stopped</strong><span>{status.error || 'The refresh could not finish.'}</span></div>
              <button type="button" onClick={runRefresh} disabled={refreshStarting}>{refreshStarting ? 'Starting…' : 'Try again'}</button>
            </div>
          )}

          {status.status === 'partial' && (
            <div className={styles.warningCallout}>
              <div><strong>Refresh completed with some agency issues</strong><span>{status.error}</span></div>
              <button type="button" onClick={runRefresh} disabled={refreshStarting}>{refreshStarting ? 'Starting…' : 'Retry refresh'}</button>
            </div>
          )}

          <div className={styles.summaryRow}>
            <strong>{visibleContracts.length} contract{visibleContracts.length === 1 ? '' : 's'}</strong>
            <span>{showHidden && hiddenCount ? `${hiddenCount} hidden contract${hiddenCount === 1 ? '' : 's'} included · ` : ''}{status.refreshedAt ? `Last refreshed: ${formatRefreshTime(status.refreshedAt)}` : 'Not refreshed yet'}</span>
          </div>
          {error && <div className={styles.errorCallout}><span>{error}</span></div>}

          <div className={styles.tableCard}>
            {loading ? <div className={styles.loading}>Loading expiring contracts…</div> : visibleContracts.length === 0 ? (
              <div className={styles.empty}>No eligible contracts are available for this range and agency selection.</div>
            ) : (
              <div className={styles.tableScroll}>
                <table className="data-table">
                  <thead><tr>
                    <th>Contract</th><th>Agency and office</th><th>Incumbent</th><th>NAICS / PSC</th><th>Contract vehicle</th><th>Ultimate completion</th><th>Total value</th><th>Actions</th><th aria-label="Contract details" />
                  </tr></thead>
                  <tbody>
                    {visibleContracts.map((contract) => {
                      const existing = pipelineById.get(String(contract.piid || '').toUpperCase())
                      const isOpen = expanded.has(contract.familyKey)
                      const detail = details[contract.familyKey] || contract
                      return [
                        <tr key={contract.familyKey} className={contract.hidden ? styles.hiddenRow : ''}>
                          <td><strong>{contract.title || contract.piid}</strong><small><CopyValue value={contract.piid} label="PIID">{contract.piid}</CopyValue></small>{contract.hidden && <small className={styles.hiddenLabel}>Hidden from normal results</small>}</td>
                          <td><span>{contract.agency || 'Not available'}</span><small>{contract.office || contract.department || ''}</small></td>
                          <td><span>{contract.incumbentName || 'Not available'}</span><small>{contract.incumbentUEI && <CopyValue value={contract.incumbentUEI} label="UEI">{contract.incumbentUEI}</CopyValue>}</small></td>
                          <td><span>{contract.naicsCode || 'Not available'}</span>{contract.pscCode && <small>PSC {contract.pscCode}</small>}</td>
                          <td>
                            {contract.vehicleResolution?.status === 'RESOLVED' ? (
                              <div className={styles.vehicleValue}>
                                <span>{contract.vehicleResolution.vehicleName}</span>
                                {contract.vehicleResolution.vehicleVariant && <small>{contract.vehicleResolution.vehicleVariant}</small>}
                              </div>
                            ) : contract.referencedIdvPiid ? (
                              <span>
                                <strong>Needs review</strong>
                                <small>{contract.referencedIdvPiid}</small>
                                <button type="button" className={styles.inlineRuleButton} disabled={vehicleRuleSaving === contract.familyKey} onClick={() => addExactVehicleRule(contract)}>
                                  {vehicleRuleSaving === contract.familyKey ? 'Saving…' : 'Add vehicle rule'}
                                </button>
                              </span>
                            ) : ''}
                          </td>
                          <td>{contract.ultimateCompletionDate ? formatDate(contract.ultimateCompletionDate) : 'Not available'}</td>
                          <td title={fullMoney(contract.totalContractValue)}>{compactMoney(contract.totalContractValue)}</td>
                          <td>
                            <div className={styles.actions}>
                              {existing
                                ? <button type="button" className={styles.pipelineButton} onClick={() => openOpportunity(existing)}>View in pipeline</button>
                                : <button type="button" className={styles.pipelineButton} disabled={addingKey === contract.familyKey} onClick={() => handleAdd(contract)}>{addingKey === contract.familyKey ? 'Adding…' : 'Add to pipeline'}</button>}
                              {contract.samLink && <a className={styles.samButton} href={contract.samLink} target="_blank" rel="noreferrer">SAM.gov</a>}
                              <button type="button" className={contract.hidden ? styles.restoreButton : styles.visibilityButton} disabled={visibilityKey === contract.familyKey} onClick={() => changeContractVisibility(contract, !contract.hidden)}>{visibilityKey === contract.familyKey ? 'Saving…' : contract.hidden ? 'Restore' : 'Hide'}</button>
                            </div>
                          </td>
                          <td><button type="button" className={styles.expandButton} title={isOpen ? 'Collapse contract details' : 'Expand contract details'} aria-expanded={isOpen} onClick={() => toggleDetails(contract)}>{isOpen ? '⌃' : '⌄'}</button></td>
                        </tr>,
                        isOpen && <tr key={`${contract.familyKey}-detail`} className={styles.detailRow}><td colSpan="9">
                          {detailLoading.has(contract.familyKey) ? <div className={styles.loading}>Loading award family and public contacts…</div> : (
                            <div className={styles.detailPanel}>
                              <section><h4>Contract identity</h4><div className={styles.detailGrid}>
                                <DetailField label="PIID" value={detail.piid} />
                                <DetailField label="Contract classification" value={detail.awardType} />
                                <DetailField label="Solicitation number" value={detail.solicitationNumber} />
                                <DetailField label="Referenced IDV" value={detail.referencedIdvPiid} />
                                <DetailField label="Contract vehicle" value={detail.vehicleResolution?.status === 'RESOLVED' ? [detail.vehicleResolution.vehicleName, detail.vehicleResolution.vehicleVariant].filter(Boolean).join(' · ') : null} />
                              </div></section>
                              <section><h4>Agency and scope</h4><div className={styles.detailGrid}>
                                <DetailField label="Department" value={detail.department} />
                                <DetailField label="Agency" value={detail.agency} />
                                <DetailField label="Contracting office" value={detail.office} />
                                <DetailField label="NAICS" value={detail.naicsCode} />
                                <DetailField label="Product Service Code" value={detail.pscCode} />
                                <DetailField label="Description" value={detail.description} />
                              </div></section>
                              <section><h4>Incumbent and value</h4><div className={styles.detailGrid}>
                                <DetailField label="Incumbent" value={detail.incumbentName} />
                                <DetailField label="UEI" value={detail.incumbentUEI} />
                                <DetailField label="Total base and all options" value={fullMoney(detail.totalContractValue)} />
                                <DetailField label="Set-aside" value={detail.setAside} />
                              </div><CompactEightAStatus uei={detail.incumbentUEI} contractEndDate={detail.ultimateCompletionDate} /></section>
                              <section><h4>Dates</h4><div className={styles.detailGrid}>
                                <DetailField label="Period of performance start" value={detail.periodOfPerformanceStartDate ? formatDate(detail.periodOfPerformanceStartDate) : null} />
                                <DetailField label="Current completion" value={detail.currentCompletionDate ? formatDate(detail.currentCompletionDate) : null} />
                                <DetailField label="Ultimate completion" value={detail.ultimateCompletionDate ? formatDate(detail.ultimateCompletionDate) : null} />
                                <DetailField label="Latest option exercise" value={detail.eligibility?.lastOptionDate ? formatDate(detail.eligibility.lastOptionDate) : null} />
                              </div></section>
                              <section className={styles.wideSection}><h4>Latest three modifications</h4>
                                <div className={styles.innerTable}><table><thead><tr><th>Modification</th><th>Signed</th><th>Reason</th><th>Last modified by</th><th>Last modified</th><th>Action value</th></tr></thead><tbody>
                                  {(detail.modifications || []).map((modification, index) => {
                                    const choiceKey = `${contract.familyKey}:${modification.modificationNumber || index}`
                                    return (
                                      <tr key={`${modification.modificationNumber}-${index}`}>
                                        <td>{modification.modificationNumber || '0'}</td>
                                        <td>{modification.dateSigned ? formatDate(modification.dateSigned) : 'Not available'}</td>
                                        <td>{modification.reason || 'Not provided'}</td>
                                        <td><ModifierIdentity resolution={resolveModifierWithCrmContacts(modification.modifierResolution || { raw: modification.lastModifiedBy, status: 'unresolved', matches: [] }, detail.agency, contacts)} choice={modifierChoices[choiceKey]} onChoose={(value) => setModifierChoices((current) => ({ ...current, [choiceKey]: value }))} /></td>
                                        <td>{modification.lastModifiedDate ? formatDate(modification.lastModifiedDate) : 'Not available'}</td>
                                        <td>{fullMoney(modification.actionObligation)}</td>
                                      </tr>
                                    )
                                  })}
                                </tbody></table></div>
                              </section>
                              <section className={styles.wideSection}><h4>Recent public points of contact</h4>
                                {(detail.publicPocs || []).length ? <div className={styles.pocList}>{detail.publicPocs.map((poc) => <article key={`${poc.email}-${poc.noticeId}`}><div><strong>{poc.name || poc.email}</strong><span>{[poc.role, poc.email, poc.phone].filter(Boolean).join(' · ')}</span></div><div><small>{[poc.noticeType, poc.noticeDate ? formatDate(poc.noticeDate) : ''].filter(Boolean).join(' · ')}</small>{poc.sourceLink && <a href={poc.sourceLink} target="_blank" rel="noreferrer">View source notice</a>}</div></article>)}</div> : <p className={styles.muted}>No related public notice contacts were found.</p>}
                              </section>
                              <div className={styles.detailActions}>
                                <button type="button" className="btn" onClick={() => navigate(`/lookup?piid=${encodeURIComponent(contract.piid)}${contract.incumbentUEI ? `&uei=${encodeURIComponent(contract.incumbentUEI)}` : ''}`)}>Open in Awards Lookup</button>
                                {contract.samLink && <a className="btn" href={contract.samLink} target="_blank" rel="noreferrer">View on SAM.gov</a>}
                              </div>
                            </div>
                          )}
                        </td></tr>,
                      ]
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}
