import { useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import Topbar from '@/components/Layout/Topbar'
import { usePipeline } from '@/hooks/usePipeline'
import { ensureTableColumns, getSAMOpportunities, updateRowWithReconciliation } from '@/services/graphService'
import {
  agencyIdPatch,
  buildSAMAgencyIdReference,
  findPipelineAgencyMatch,
  pipelineAgencySearchTerms,
} from '@/lib/agencyIntelligence'
import {
  getAgencyVehicleUsage,
  getAgencyVehicleUsageStatus,
  getAgencyVehicles,
  getOfficialAgencyMapping,
  getVehicleActivity,
  saveOfficialAgencyMapping,
  searchOfficialAgencies,
} from '@/services/agencyIntelligenceService'
import styles from './AgencyIntelligence.module.css'

const DEPARTMENT = 'Department*'
const AGENCY = 'Agency*'
const OFFICE = 'Office*'
const AGENCY_ID_COLUMNS = ['Department ID', 'Agency ID']
const RAW_PAGE_SIZE = 50
const USAGE_PAGE_SIZE = 25

function clean(value) { return String(value || '').trim() }
function normalized(value) {
  return clean(value).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}
function money(value) {
  const amount = Number(value || 0)
  if (Math.abs(amount) >= 1_000_000_000) return `$${(amount / 1_000_000_000).toFixed(1)}B`
  if (Math.abs(amount) >= 1_000_000) return `$${(amount / 1_000_000).toFixed(1)}M`
  if (Math.abs(amount) >= 1_000) return `$${(amount / 1_000).toFixed(1)}K`
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(amount)
}
function fullMoney(value) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(Number(value || 0))
}
function date(value) {
  if (!value) return 'Not reported'
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}
function wait(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds)
    signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new DOMException('Cancelled', 'AbortError')) }, { once: true })
  })
}
function pipelineAgencies(pipeline) {
  const grouped = new Map()
  pipeline.forEach((opportunity) => {
    const department = clean(opportunity[DEPARTMENT])
    const agency = clean(opportunity[AGENCY])
    const office = clean(opportunity[OFFICE])
    const name = agency || department
    if (!name) return
    const parentName = agency && normalized(agency) !== normalized(department) ? department : ''
    const departmentId = clean(opportunity['Department ID'])
    const agencyId = clean(opportunity['Agency ID'])
    const key = `${departmentId || normalized(parentName)}:${agencyId || normalized(name)}`
    const current = grouped.get(key) || { name, parentName, departmentId, agencyId, count: 0, offices: new Set() }
    current.count += 1
    if (office) current.offices.add(office)
    grouped.set(key, current)
  })
  return [...grouped.values()].map((item) => ({ ...item, offices: [...item.offices] })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
}
function agencyFromParams(params) {
  const name = clean(params.get('agency'))
  return name ? {
    name,
    tier: params.get('tier') === 'subtier' ? 'subtier' : 'toptier',
    parentName: clean(params.get('parent')),
    abbreviation: clean(params.get('abbr')),
    toptierCode: clean(params.get('code')),
    id: clean(params.get('id')) || null,
    departmentId: clean(params.get('departmentId')),
    agencyId: clean(params.get('agencyId')),
  } : null
}
function agencyLabel(agency) {
  return agency?.abbreviation && normalized(agency.abbreviation) !== normalized(agency.name)
    ? `${agency.name} (${agency.abbreviation})`
    : agency?.name || ''
}
function mappingKey(candidate) { return `tag_agency_match:v1:${normalized(candidate?.parentName)}:${normalized(candidate?.name)}` }
function readRememberedAgency(candidate) {
  try { return JSON.parse(localStorage.getItem(mappingKey(candidate)) || 'null') } catch { return null }
}
function rememberAgency(candidate, agency) {
  try { localStorage.setItem(mappingKey(candidate), JSON.stringify(agency)) } catch { /* optional convenience cache */ }
}

function RawVehicleDetails({ vehicle, detail, loading, error, onClose }) {
  if (!vehicle) return null
  return <div className={styles.drawerContent}>
    <div className={styles.drawerHeader}><div><span className={styles.eyebrow}>IDV record</span><h3>{vehicle.awardId || 'Vehicle record'}</h3></div><button className={styles.closeButton} type="button" onClick={onClose} aria-label="Close vehicle details">×</button></div>
    <p className={styles.drawerDescription}>{vehicle.description || 'No description reported by USAspending.'}</p>
    <div className={styles.vehicleFacts}>
      <div><span>Contractor</span><strong>{vehicle.contractor || 'Not reported'}</strong><small>{vehicle.contractorUEI ? `UEI ${vehicle.contractorUEI}` : ''}</small></div>
      <div><span>Vehicle type</span><strong>{vehicle.vehicleType || 'Not reported'}</strong></div>
      <div><span>NAICS</span><strong>{vehicle.naicsCode || 'Not reported'}</strong><small>{vehicle.naicsDescription}</small></div>
      <div><span>PSC</span><strong>{vehicle.pscCode || 'Not reported'}</strong><small>{vehicle.pscDescription}</small></div>
      <div><span>Start date</span><strong>{date(vehicle.startDate)}</strong></div>
      <div><span>Last date to order</span><strong>{date(vehicle.lastDateToOrder)}</strong></div>
    </div>
    {vehicle.generatedId && <a className="btn text-sm" href={`https://www.usaspending.gov/award/${encodeURIComponent(vehicle.generatedId)}`} target="_blank" rel="noreferrer">View on USAspending.gov</a>}
    {loading ? <div className={styles.detailLoading}>Loading order activity…</div> : error ? <div className={styles.inlineError}>{error}</div> : detail ? <>
      <div className={styles.activityMetrics}>
        <div><span>Orders</span><strong>{detail.totalOrderCount.toLocaleString()}</strong></div>
        <div title={fullMoney(detail.totalObligations)}><span>Obligations</span><strong>{money(detail.totalObligations)}</strong></div>
      </div>
      {detail.displayedOrders.length > 0 && <div className={styles.drawerOrders}>{detail.displayedOrders.slice(0, 12).map((order) => <div key={order.generatedId || `${order.awardId}:${order.contractor}`}><strong>{order.awardId || 'Order'}</strong><span>{order.contractor || 'Contractor not reported'}</span><b>{money(order.obligatedAmount)}</b></div>)}</div>}
    </> : null}
  </div>
}

function UsageVehicleDetails({ vehicle, onClose }) {
  if (!vehicle) return null
  return <div className={styles.drawerContent}>
    <div className={styles.drawerHeader}><div><span className={styles.eyebrow}>Vehicle usage</span><h3>{vehicle.vehicleName || vehicle.parentAwardId}</h3></div><button className={styles.closeButton} type="button" onClick={onClose} aria-label="Close vehicle details">×</button></div>
    {vehicle.vehicleName && <p className={styles.drawerDescription}>Parent award {vehicle.parentAwardId}</p>}
    <div className={styles.activityMetrics}>
      <div><span>Orders</span><strong>{vehicle.orders.toLocaleString()}</strong></div>
      <div><span>Contractors</span><strong>{vehicle.contractors.toLocaleString()}</strong></div>
      <div title={fullMoney(vehicle.obligations)}><span>Obligations</span><strong>{money(vehicle.obligations)}</strong></div>
      <div><span>Last used</span><strong>{date(vehicle.lastUsed)}</strong></div>
    </div>
    <div className={styles.vehicleFacts}>
      <div><span>Common NAICS</span><strong>{vehicle.topNaics || 'Not reported'}</strong></div>
      <div><span>Common PSC</span><strong>{vehicle.topPsc || 'Not reported'}</strong></div>
      <div><span>Vehicle type</span><strong>{vehicle.vehicleType || 'Not reported'}</strong></div>
      <div><span>Last date to order</span><strong>{date(vehicle.lastDateToOrder)}</strong></div>
    </div>
    {vehicle.generatedId && <a className="btn text-sm" href={`https://www.usaspending.gov/award/${encodeURIComponent(vehicle.generatedId)}`} target="_blank" rel="noreferrer">View on USAspending.gov</a>}
    {vehicle.sampleOrders?.length > 0 && <section><h4 className={styles.drawerSectionTitle}>Recent matching orders</h4><div className={styles.drawerOrders}>{vehicle.sampleOrders.map((order) => <div key={order.generatedId || order.awardId}><strong>{order.awardId || 'Order'}</strong><span>{order.contractor || 'Contractor not reported'}</span><b>{money(order.obligation)}</b></div>)}</div></section>}
  </div>
}

export default function AgencyIntelligence() {
  const { pipeline, refresh: refreshPipeline } = usePipeline()
  const [searchParams, setSearchParams] = useSearchParams()
  const [query, setQuery] = useState('')
  const [searchResults, setSearchResults] = useState([])
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState('')
  const [resolving, setResolving] = useState('')
  const [pendingCandidate, setPendingCandidate] = useState(null)
  const [selectedAgency, setSelectedAgency] = useState(() => agencyFromParams(searchParams))
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [viewMode, setViewMode] = useState('usage')
  const [scope, setScope] = useState('funding')
  const [usage, setUsage] = useState(null)
  const [usageRun, setUsageRun] = useState(null)
  const [usageLoading, setUsageLoading] = useState(false)
  const [usageError, setUsageError] = useState('')
  const [usageFilter, setUsageFilter] = useState('')
  const [usagePage, setUsagePage] = useState(1)
  const [usageRefresh, setUsageRefresh] = useState(0)
  const forceUsageRefresh = useRef(false)
  const [selectedUsage, setSelectedUsage] = useState(null)
  const [vehicles, setVehicles] = useState([])
  const [totalVehicles, setTotalVehicles] = useState(null)
  const [page, setPage] = useState(1)
  const [hasNext, setHasNext] = useState(false)
  const [vehicleLoading, setVehicleLoading] = useState(false)
  const [vehicleError, setVehicleError] = useState('')
  const [vehicleWarning, setVehicleWarning] = useState('')
  const [cacheState, setCacheState] = useState('')
  const [fetchedAt, setFetchedAt] = useState('')
  const [vehicleFilter, setVehicleFilter] = useState('')
  const [selectedVehicle, setSelectedVehicle] = useState(null)
  const [vehicleDetail, setVehicleDetail] = useState(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState('')
  const [idSync, setIdSync] = useState({ running: false, message: '' })
  const searchRequest = useRef(0)
  const pipelineAgencyList = useMemo(() => pipelineAgencies(pipeline), [pipeline])

  const pipelineMatch = useMemo(() => selectedAgency ? pipelineAgencyList.find((item) => {
    if (selectedAgency.departmentId && selectedAgency.agencyId && item.departmentId === selectedAgency.departmentId && item.agencyId === selectedAgency.agencyId) return true
    const names = [selectedAgency.name, selectedAgency.parentName].map(normalized).filter(Boolean)
    return names.includes(normalized(item.name)) || names.includes(normalized(item.parentName))
  }) || null : null, [pipelineAgencyList, selectedAgency])

  useEffect(() => {
    const text = query.trim()
    if (text.length < 2) { setSearchResults([]); setSearchError(''); setSearching(false); return undefined }
    const requestId = ++searchRequest.current
    const controller = new AbortController()
    const timer = setTimeout(async () => {
      setSearching(true); setSearchError('')
      try {
        const result = await searchOfficialAgencies(text, { signal: controller.signal })
        if (requestId === searchRequest.current) setSearchResults(result.agencies || [])
      } catch (error) {
        if (error.name !== 'AbortError' && requestId === searchRequest.current) { setSearchError(error.message); setSearchResults([]) }
      } finally { if (requestId === searchRequest.current) setSearching(false) }
    }, 300)
    return () => { clearTimeout(timer); controller.abort() }
  }, [query])

  const chooseAgency = (agency) => {
    const nextAgency = pendingCandidate ? { ...agency, departmentId: pendingCandidate.departmentId, agencyId: pendingCandidate.agencyId } : agency
    if (pendingCandidate) {
      rememberAgency(pendingCandidate, nextAgency)
      saveOfficialAgencyMapping(pendingCandidate, nextAgency).catch((error) => {
        console.warn('[Agency Intelligence] Shared agency match could not be saved', { error: error.message })
      })
    }
    setPendingCandidate(null); setSelectedAgency(nextAgency); setPage(1); setUsagePage(1); setVehicleFilter(''); setUsageFilter(''); setSelectedVehicle(null); setSelectedUsage(null)
    setSearchParams((current) => {
      const next = new URLSearchParams(current)
      ;[['agency', nextAgency.name], ['tier', nextAgency.tier], ['parent', nextAgency.parentName], ['abbr', nextAgency.abbreviation], ['code', nextAgency.toptierCode], ['id', nextAgency.id], ['departmentId', nextAgency.departmentId], ['agencyId', nextAgency.agencyId]].forEach(([key, value]) => { if (value !== null && value !== undefined && value !== '') next.set(key, value); else next.delete(key) })
      return next
    }, { replace: true })
  }

  const resolvePipelineAgency = async (candidate) => {
    if (resolving) return
    const remembered = readRememberedAgency(candidate)
    if (remembered) { chooseAgency({ ...remembered, departmentId: candidate.departmentId, agencyId: candidate.agencyId }); return }
    setResolving(candidate.name); setSearchError('')
    try {
      let resolved = null
      try {
        resolved = await getOfficialAgencyMapping(candidate)
      } catch (error) {
        console.warn('[Agency Intelligence] Shared agency resolver unavailable; continuing with direct search', { error: error.message })
      }
      if (resolved?.agency) {
        rememberAgency(candidate, resolved.agency)
        chooseAgency({ ...resolved.agency, departmentId: candidate.departmentId, agencyId: candidate.agencyId })
        return
      }
      const agencies = []; const seen = new Set(); let match = null
      for (const term of pipelineAgencySearchTerms(candidate)) {
        const result = await searchOfficialAgencies(term)
        for (const agency of result.agencies || []) { const key = `${agency.id}:${agency.tier}:${normalized(agency.name)}`; if (!seen.has(key)) { seen.add(key); agencies.push(agency) } }
        match = findPipelineAgencyMatch(candidate, agencies)
        if (match) break
      }
      if (!match) {
        setPendingCandidate(candidate); setQuery(candidate.name); setSearchResults(agencies)
        throw new Error(agencies.length ? 'Select the matching official agency from the results.' : 'No official USAspending agency match was found. Search and select the correct agency once to remember it.')
      }
      rememberAgency(candidate, match)
      saveOfficialAgencyMapping(candidate, match).catch((error) => {
        console.warn('[Agency Intelligence] Shared agency match could not be saved', { error: error.message })
      })
      chooseAgency({ ...match, departmentId: candidate.departmentId, agencyId: candidate.agencyId })
    } catch (error) { setSearchError(error.message) } finally { setResolving('') }
  }

  useEffect(() => {
    if (!selectedAgency || viewMode !== 'usage') return undefined
    const controller = new AbortController(); let active = true
    const load = async () => {
      setUsageLoading(true); setUsageError(''); setUsageRun(null); setSelectedUsage(null)
      try {
        let response = await getAgencyVehicleUsage(selectedAgency, { scope, forceRefresh: forceUsageRefresh.current, signal: controller.signal })
        forceUsageRefresh.current = false
        while (active && ['queued', 'running'].includes(response.status)) {
          setUsageRun(response)
          await wait(2500, controller.signal)
          response = await getAgencyVehicleUsageStatus(selectedAgency, { scope, signal: controller.signal })
        }
        if (!active) return
        if (response.status === 'ready') { setUsage(response.result); setUsageRun(null) }
        else if (response.status === 'error') throw new Error(response.error || 'Vehicle usage could not be prepared')
        else throw new Error('Vehicle usage did not finish loading')
      } catch (error) { if (error.name !== 'AbortError' && active) setUsageError(error.message) }
      finally { if (active) setUsageLoading(false) }
    }
    load()
    return () => { active = false; controller.abort() }
  }, [selectedAgency, scope, usageRefresh, viewMode])

  useEffect(() => {
    if (!selectedAgency || viewMode !== 'browse') return undefined
    const controller = new AbortController(); let active = true
    setVehicleLoading(true); setVehicleError(''); setVehicleWarning(''); setSelectedVehicle(null); setVehicleDetail(null)
    getAgencyVehicles(selectedAgency, { page, limit: RAW_PAGE_SIZE, signal: controller.signal }).then((result) => {
      if (!active) return
      setVehicles(result.vehicles || []); setTotalVehicles(result.totalVehicles ?? null); setHasNext(Boolean(result.hasNext)); setCacheState(result.cache || ''); setFetchedAt(result.fetchedAt || ''); setVehicleWarning(result.warning || '')
    }).catch((error) => { if (active && error.name !== 'AbortError') setVehicleError(error.message) }).finally(() => { if (active) setVehicleLoading(false) })
    return () => { active = false; controller.abort() }
  }, [selectedAgency, page, viewMode])

  const refreshCurrent = () => {
    if (viewMode === 'usage') { forceUsageRefresh.current = true; setUsageRefresh((value) => value + 1) }
    else { setPage((value) => value); setVehicleLoading(true); getAgencyVehicles(selectedAgency, { page, limit: RAW_PAGE_SIZE, forceRefresh: true }).then((result) => { setVehicles(result.vehicles || []); setTotalVehicles(result.totalVehicles ?? null); setHasNext(Boolean(result.hasNext)); setCacheState(result.cache || ''); setFetchedAt(result.fetchedAt || '') }).catch((error) => setVehicleError(error.message)).finally(() => setVehicleLoading(false)) }
  }

  const selectRawVehicle = async (vehicle) => {
    setSelectedVehicle(vehicle); setVehicleDetail(null); setDetailError(''); setDetailLoading(true)
    try { if (!vehicle.generatedId) throw new Error('USAspending did not provide the identifier needed for order activity.'); setVehicleDetail(await getVehicleActivity(vehicle.generatedId)) }
    catch (error) { setDetailError(error.message) } finally { setDetailLoading(false) }
  }

  const syncAgencyIds = async () => {
    if (idSync.running || pipeline.length === 0) return
    setIdSync({ running: true, message: 'Preparing ID columns…' })
    try {
      await ensureTableColumns('PipelineTable', AGENCY_ID_COLUMNS); await ensureTableColumns('NewOpportunitiesTable', AGENCY_ID_COLUMNS)
      const pulled = await getSAMOpportunities(); const reference = buildSAMAgencyIdReference(pulled)
      let updated = 0; let unresolved = 0; let failed = 0
      for (let index = 0; index < pipeline.length; index += 1) {
        const opportunity = pipeline[index]; const patch = agencyIdPatch(opportunity, reference)
        if (Object.keys(patch).length) { try { await updateRowWithReconciliation('PipelineTable', opportunity._rowIndex, patch); updated += 1 } catch { failed += 1 } }
        else if (!opportunity['Department ID'] || !opportunity['Agency ID']) unresolved += 1
        setIdSync({ running: true, message: `Checking ${index + 1} of ${pipeline.length}…` })
      }
      await refreshPipeline()
      const hasIds = pulled.some((row) => row['Department ID'] || row['Agency ID'])
      setIdSync({ running: false, message: hasIds ? `${updated} updated${unresolved ? ` · ${unresolved} unresolved` : ''}${failed ? ` · ${failed} could not be saved` : ''}` : 'Columns are ready. Run a SAM pull, then sync again.' })
    } catch (error) { setIdSync({ running: false, message: `ID sync failed: ${error.message}` }) }
  }

  const filteredUsage = useMemo(() => {
    const value = normalized(usageFilter)
    return (usage?.vehicles || []).filter((vehicle) => !value || [vehicle.vehicleName, vehicle.parentAwardId, vehicle.vehicleType, vehicle.topNaics, vehicle.topPsc].some((field) => normalized(field).includes(value)))
  }, [usage, usageFilter])
  const usagePages = Math.max(1, Math.ceil(filteredUsage.length / USAGE_PAGE_SIZE))
  const usageRows = filteredUsage.slice((usagePage - 1) * USAGE_PAGE_SIZE, usagePage * USAGE_PAGE_SIZE)
  const filteredVehicles = useMemo(() => { const value = normalized(vehicleFilter); return vehicles.filter((vehicle) => !value || [vehicle.awardId, vehicle.description, vehicle.contractor, vehicle.vehicleType, vehicle.naicsCode, vehicle.pscCode].some((field) => normalized(field).includes(value))) }, [vehicles, vehicleFilter])
  const rawPages = totalVehicles === null ? (hasNext ? page + 1 : page) : Math.max(1, Math.ceil(totalVehicles / RAW_PAGE_SIZE))
  const progressPercent = usageRun?.totalOrders ? Math.min(100, Math.round((Number(usageRun.processedOrders || 0) / usageRun.totalOrders) * 100)) : null
  const progressDetail = usageRun?.phase === 'resolving'
    ? `${Number(usageRun.processedOrders || 0).toLocaleString()} orders grouped`
    : Number(usageRun?.processedOrders || 0) > 0
      ? `${Number(usageRun.processedOrders).toLocaleString()} orders checked${usageRun.page ? ` · Page ${usageRun.page}` : ''}`
      : 'Loading the first order page'

  return <>
    <Topbar title="Agency Intelligence" subtitle1="Federal contract vehicles" subtitle2="USAspending.gov" showFilter={false} />
    <div className={`page-body ${styles.page}`}><div className={`card ${styles.workspace} ${sidebarCollapsed ? styles.workspaceCollapsed : ''}`}>
      <aside className={`${styles.agencyPanel} ${sidebarCollapsed ? styles.agencyPanelCollapsed : ''}`}>
        <button className={styles.panelToggle} type="button" onClick={() => setSidebarCollapsed((value) => !value)} title={sidebarCollapsed ? 'Open agency list' : 'Close agency list'} aria-label={sidebarCollapsed ? 'Open agency list' : 'Close agency list'}>{sidebarCollapsed ? '›' : '‹'}</button>
        {!sidebarCollapsed && <div className={styles.agencyPanelBody}>
          <div className={styles.agencySearch}><label htmlFor="agency-search">Find an agency</label><input id="agency-search" className="form-input" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Name, abbreviation, or component" /><small>Search official USAspending names. A manual match is remembered for future use.</small><div className={styles.identifierSync}><button className="btn text-sm" type="button" onClick={syncAgencyIds} disabled={idSync.running || pipeline.length === 0}>{idSync.running ? 'Syncing IDs…' : 'Sync agency IDs'}</button><span>{idSync.message || 'Backfill Department ID and Agency ID from pulled SAM hierarchies.'}</span></div></div>
          {searchError && <div className={styles.searchError}>{searchError}</div>}
          <div className={styles.agencyList}><div className={styles.listHeading}><span>{query.trim().length >= 2 ? 'Official matches' : 'In your pipeline'}</span><small>{query.trim().length >= 2 ? (searching ? 'Searching…' : searchResults.length) : pipelineAgencyList.length}</small></div>
            {query.trim().length >= 2 ? (!searching && searchResults.length === 0 ? <p className={styles.emptyList}>No agency matches found.</p> : searchResults.map((agency) => <button key={`${agency.id}:${agency.tier}:${agency.name}`} type="button" className={`${styles.agencyItem} ${selectedAgency?.name === agency.name && selectedAgency?.tier === agency.tier ? styles.agencyItemActive : ''}`} onClick={() => chooseAgency(agency)}><strong>{agency.name}</strong><span>{agency.tier === 'subtier' ? `${agency.parentName} · ID ${agency.id ?? 'not reported'}` : `${agency.abbreviation || 'Federal agency'} · Code ${agency.toptierCode || 'not reported'}`}</span></button>)) : (pipelineAgencyList.length === 0 ? <p className={styles.emptyList}>No agency names are available in the pipeline.</p> : pipelineAgencyList.map((agency) => <button key={`${agency.parentName}:${agency.name}`} type="button" className={styles.agencyItem} disabled={Boolean(resolving)} onClick={() => resolvePipelineAgency(agency)}><strong>{agency.name}</strong><span>{resolving === agency.name ? 'Resolving official agency…' : `${agency.count} ${agency.count === 1 ? 'opportunity' : 'opportunities'}${agency.parentName ? ` · ${agency.parentName}` : ''}`}</span></button>))}
          </div>
        </div>}
      </aside>
      <main className={styles.detailPanel}>
        {!selectedAgency ? <div className={styles.emptyDetail}><strong>Select an agency</strong><span>Choose an agency from the pipeline or search USAspending to review the contract vehicles it uses.</span></div> : <>
          <div className={styles.fixedSummary}>
            <header className={styles.detailHeader}><div><span className={styles.eyebrow}>{selectedAgency.tier === 'subtier' ? 'Subagency' : 'Federal agency'}</span><h2>{agencyLabel(selectedAgency)}</h2><p>{selectedAgency.tier === 'subtier' ? `${selectedAgency.parentName} · USAspending ID ${selectedAgency.id ?? 'not reported'} · Parent code ${selectedAgency.toptierCode || 'not reported'}` : `Agency code ${selectedAgency.toptierCode || 'not reported'} · USAspending ID ${selectedAgency.id ?? 'not reported'}`}{pipelineMatch ? ` · ${pipelineMatch.count} pipeline ${pipelineMatch.count === 1 ? 'opportunity' : 'opportunities'}` : ''}</p></div><button className="btn text-sm" type="button" onClick={refreshCurrent} disabled={usageLoading || vehicleLoading}>{usageLoading || vehicleLoading ? 'Refreshing…' : 'Refresh data'}</button></header>
            <div className={styles.viewControls}><div className={styles.segmented}><button type="button" className={viewMode === 'usage' ? styles.segmentActive : ''} onClick={() => setViewMode('usage')}>Vehicle usage</button><button type="button" className={viewMode === 'browse' ? styles.segmentActive : ''} onClick={() => setViewMode('browse')}>Browse IDV records</button></div>{viewMode === 'usage' && <div className={styles.segmented}><button type="button" className={scope === 'funding' ? styles.segmentActive : ''} onClick={() => { setScope('funding'); setUsagePage(1) }}>Funded by agency</button><button type="button" className={scope === 'awarding' ? styles.segmentActive : ''} onClick={() => { setScope('awarding'); setUsagePage(1) }}>Awarded by agency</button></div>}</div>
            {viewMode === 'usage' && <section className={styles.summaryCards}><div><span>Vehicles used</span><strong>{usageLoading && !usage ? '…' : (usage?.totals?.vehicles || 0).toLocaleString()}</strong><small>Distinct parent awards</small></div><div><span>Orders</span><strong>{usageLoading && !usage ? '…' : (usage?.totals?.orders || 0).toLocaleString()}</strong><small>Task and delivery orders</small></div><div title={fullMoney(usage?.totals?.obligations)}><span>Obligations</span><strong>{usageLoading && !usage ? '…' : money(usage?.totals?.obligations)}</strong><small>Across the full result</small></div></section>}
          </div>
          <div className={styles.resultsScroll}>
            {viewMode === 'usage' ? <section className={styles.vehicleSection}>
              <div className={styles.vehicleToolbar}><div><h3>Contract vehicles used to buy</h3><p>{scope === 'funding' ? 'Orders funded by this agency' : 'Orders awarded by this agency'} · Last five fiscal years</p></div><input className="form-input" value={usageFilter} onChange={(event) => { setUsageFilter(event.target.value); setUsagePage(1) }} placeholder="Filter vehicle, NAICS, or PSC" /></div>
              {usageRun && <div className={styles.progressBlock}><div><span>{usageRun.phase === 'resolving' ? 'Resolving contract vehicle names' : 'Building the agency-wide vehicle aggregate'}</span><b>{progressDetail}</b></div><div className={`${styles.progressTrack} ${progressPercent === null ? styles.progressTrackIndeterminate : ''}`}><span style={progressPercent === null ? undefined : { width: `${progressPercent}%` }} /></div></div>}
              {usageError ? <div className={styles.errorState}><strong>Vehicle usage could not load</strong><span>{usageError}</span><button className="btn" type="button" onClick={() => setUsageRefresh((value) => value + 1)}>Try again</button></div> : usageLoading && !usage ? <div className={styles.loadingRows}>{[1, 2, 3, 4].map((item) => <div className="skeleton" key={item} />)}</div> : usageRows.length === 0 ? <div className={styles.noVehicles}>No task or delivery orders with a parent vehicle were found for this agency.</div> : <div className={styles.tableScroll}><table className="data-table"><thead><tr><th>Vehicle</th><th>Orders</th><th>Contractors</th><th className={styles.moneyCell}>Obligations</th><th>Last used</th><th>Common NAICS</th><th>Common PSC</th></tr></thead><tbody>{usageRows.map((vehicle) => <tr key={vehicle.parentAwardId} className={selectedUsage?.parentAwardId === vehicle.parentAwardId ? styles.selectedRow : ''} onClick={() => setSelectedUsage(vehicle)}><td><div className={styles.vehicleIdentity}><strong>{vehicle.vehicleName || vehicle.parentAwardId}</strong>{vehicle.vehicleName && <span>{vehicle.parentAwardId}</span>}</div></td><td>{vehicle.orders.toLocaleString()}</td><td>{vehicle.contractors.toLocaleString()}</td><td className={styles.moneyCell} title={fullMoney(vehicle.obligations)}>{money(vehicle.obligations)}</td><td>{date(vehicle.lastUsed)}</td><td>{vehicle.topNaics || 'Not reported'}</td><td>{vehicle.topPsc || 'Not reported'}</td></tr>)}</tbody></table></div>}
              <div className={styles.sourceRow}><span>USAspending.gov · {usage?.period ? `FY ${usage.period.firstFiscalYear} to FY ${usage.period.lastFiscalYear}` : 'Last five fiscal years'}{usage?.fetchedAt ? ` · Updated ${date(usage.fetchedAt)}` : ''}</span>{usage?.unlinkedOrders > 0 && <span>{usage.unlinkedOrders.toLocaleString()} direct awards without a parent vehicle excluded</span>}</div>
              <div className={styles.pagination}><button className="btn" type="button" disabled={usagePage <= 1} onClick={() => setUsagePage((value) => value - 1)}>Previous</button><span>Page {usagePage} of {usagePages}</span><button className="btn" type="button" disabled={usagePage >= usagePages} onClick={() => setUsagePage((value) => value + 1)}>Next</button></div>
            </section> : <section className={styles.vehicleSection}>
              <div className={styles.vehicleToolbar}><div><h3>Browse IDV records</h3><p>Inspect individual vehicle awards reported by USAspending.</p></div><input className="form-input" value={vehicleFilter} onChange={(event) => setVehicleFilter(event.target.value)} placeholder="Filter this page" /></div>
              {vehicleWarning && <div className={styles.vehicleWarning}>{vehicleWarning}</div>}
              {vehicleError ? <div className={styles.errorState}><strong>Vehicle records could not load</strong><span>{vehicleError}</span></div> : vehicleLoading ? <div className={styles.loadingRows}>{[1, 2, 3, 4].map((item) => <div className="skeleton" key={item} />)}</div> : filteredVehicles.length === 0 ? <div className={styles.noVehicles}>No IDV records were returned.</div> : <div className={styles.tableScroll}><table className="data-table"><thead><tr><th>Vehicle</th><th>Contractor</th><th>Type</th><th>Awarding component</th><th>Last date to order</th><th className={styles.moneyCell}>Award amount</th></tr></thead><tbody>{filteredVehicles.map((vehicle) => <tr key={vehicle.generatedId || vehicle.awardId} className={selectedVehicle?.generatedId === vehicle.generatedId ? styles.selectedRow : ''} onClick={() => selectRawVehicle(vehicle)}><td><div className={styles.vehicleIdentity}><strong>{vehicle.awardId || 'No award ID'}</strong><span>{vehicle.description || 'No description reported'}</span></div></td><td>{vehicle.contractor || 'Not reported'}</td><td>{vehicle.vehicleType || 'Not reported'}</td><td>{vehicle.awardingSubAgency || vehicle.awardingAgency || 'Not reported'}</td><td>{date(vehicle.lastDateToOrder)}</td><td className={styles.moneyCell}>{money(vehicle.awardAmount)}</td></tr>)}</tbody></table></div>}
              <div className={styles.sourceRow}><span>USAspending.gov · {cacheState === 'stale' ? 'saved copy' : cacheState === 'cache' ? 'cached' : 'live'}{fetchedAt ? ` · Updated ${date(fetchedAt)}` : ''}</span><span>{totalVehicles === null ? `${filteredVehicles.length} shown` : `${totalVehicles.toLocaleString()} total records`}</span></div>
              <div className={styles.pagination}><button className="btn" type="button" disabled={page <= 1 || vehicleLoading} onClick={() => setPage((value) => Math.max(1, value - 1))}>Previous</button><span>Page {page} of {rawPages}</span><button className="btn" type="button" disabled={!hasNext || vehicleLoading} onClick={() => setPage((value) => value + 1)}>Next</button></div>
            </section>}
          </div>
          {(selectedUsage || selectedVehicle) && <div className={styles.drawerBackdrop} onClick={() => { setSelectedUsage(null); setSelectedVehicle(null) }}><aside className={styles.vehicleDrawer} onClick={(event) => event.stopPropagation()}>{selectedUsage ? <UsageVehicleDetails vehicle={selectedUsage} onClose={() => setSelectedUsage(null)} /> : <RawVehicleDetails vehicle={selectedVehicle} detail={vehicleDetail} loading={detailLoading} error={detailError} onClose={() => setSelectedVehicle(null)} />}</aside></div>}
        </>}
      </main>
    </div></div>
  </>
}
