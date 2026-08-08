import { useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import Topbar from '@/components/Layout/Topbar'
import { usePipeline } from '@/hooks/usePipeline'
import { ensureTableColumns, getSAMOpportunities, updateRowWithReconciliation } from '@/services/graphService'
import { agencyIdPatch, buildSAMAgencyIdReference, normalizeAgencyIdentity } from '@/lib/agencyIntelligence'
import { getAgencyVehicleReport } from '@/services/agencyIntelligenceService'
import { TARGET_AGENCY_GROUPS } from '@/config/targetAgencies'
import { exportAgencyVehicleDocument } from '@/utils/agencyIntelligenceExport'
import styles from './AgencyIntelligence.module.css'

const DEPARTMENT = 'Department*'
const AGENCY = 'Agency*'
const OFFICE = 'Office*'
const AGENCY_ID_COLUMNS = ['Department ID', 'Agency ID']
const PAGE_SIZE = 25

function clean(value) { return String(value ?? '').trim() }
function normalized(value) { return normalizeAgencyIdentity(value) }
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
function join(values, fallback = 'Not reported') {
  const cleaned = [...new Set((values || []).map(clean).filter(Boolean))]
  return cleaned.length ? cleaned.join('; ') : fallback
}

function pipelineAgencies(pipeline) {
  const grouped = new Map()
  pipeline.forEach((opportunity) => {
    const department = clean(opportunity[DEPARTMENT])
    const agency = clean(opportunity[AGENCY])
    const office = clean(opportunity[OFFICE])
    const name = agency || department
    if (!name) return
    const isSubtier = agency && normalized(agency) !== normalized(department)
    const parentName = isSubtier ? department : name
    const departmentId = clean(opportunity['Department ID'])
    const agencyId = clean(opportunity['Agency ID'] || departmentId)
    const key = `${departmentId || normalized(parentName)}:${agencyId || normalized(name)}`
    const current = grouped.get(key) || {
      name,
      parentName,
      departmentId,
      agencyId,
      tier: isSubtier ? 'subtier' : 'department',
      count: 0,
      offices: new Set(),
    }
    current.count += 1
    if (office) current.offices.add(office)
    grouped.set(key, current)
  })
  return [...grouped.values()]
    .map((item) => ({ ...item, offices: [...item.offices] }))
    .sort((left, right) => left.parentName.localeCompare(right.parentName) || left.name.localeCompare(right.name))
}

function agencyFromParams(params) {
  const name = clean(params.get('agency'))
  if (!name) return null
  return {
    name,
    tier: params.get('tier') === 'department' ? 'department' : 'subtier',
    parentName: clean(params.get('parent')) || name,
    departmentId: clean(params.get('departmentId')),
    agencyId: clean(params.get('agencyId')),
  }
}

function agencyKey(agency) {
  return `${agency?.tier}:${clean(agency?.departmentId)}:${clean(agency?.agencyId)}:${normalized(agency?.name)}`
}

function targetAgencyGroups(pipelineAgencyList) {
  return TARGET_AGENCY_GROUPS.map((group) => ({
    ...group,
    agencies: group.agencies.map((target) => {
      const targetName = normalized(target.searchName || target.name)
      const targetParent = normalized(target.parentName)
      const pipelineMatch = pipelineAgencyList.find((candidate) => {
        const candidateName = normalized(candidate.name)
        const candidateParent = normalized(candidate.parentName)
        return (candidateName === targetName || candidateName.includes(targetName) || targetName.includes(candidateName)) &&
          (!targetParent || candidateParent === targetParent || candidateParent.includes(targetParent) || targetParent.includes(candidateParent))
      })
      return {
        ...target,
        departmentLabel: group.department,
        departmentId: pipelineMatch?.departmentId || target.departmentId || '',
        agencyId: pipelineMatch?.agencyId || target.agencyId || '',
        count: pipelineMatch?.count || 0,
      }
    }),
  }))
}

function VehicleDetails({ vehicle, onClose }) {
  if (!vehicle) return null
  return <div className={styles.drawerContent}>
    <div className={styles.drawerHeader}>
      <div><span className={styles.eyebrow}>Vehicle or category</span><h3>{vehicle.vehicleName}</h3></div>
      <button className={styles.closeButton} type="button" onClick={onClose} aria-label="Close vehicle details">×</button>
    </div>
    <div className={styles.drawerMetrics}>
      <div><span>Records</span><strong>{vehicle.recordCount.toLocaleString()}</strong></div>
      <div><span>Identifiers</span><strong>{vehicle.identifierCount.toLocaleString()}</strong></div>
      <div title={fullMoney(vehicle.totalContractValue)}><span>Total contract value</span><strong>{money(vehicle.totalContractValue)}</strong></div>
    </div>
    <section className={styles.drawerSection}>
      <div className={styles.drawerSectionHeader}><div><h4>Vehicle identifiers</h4><p>The parent IDVs used by the contracting agency.</p></div></div>
      <div className={styles.drawerTableScroll}><table className="data-table"><thead><tr><th>Identifier</th><th>Issuing agency code</th><th>Type</th><th>Issuing department</th><th>Last date to order</th><th className={styles.moneyCell}>IDV value</th></tr></thead><tbody>
        {vehicle.identifiers.map((identifier) => <tr key={`${identifier.agencyId}:${identifier.piid}`}><td><strong>{identifier.piid}</strong></td><td>{identifier.agencyId || 'Not reported'}</td><td>{identifier.type || 'Not reported'}</td><td>{identifier.issuingDepartment || 'Not reported'}</td><td>{date(identifier.lastDateToOrder)}</td><td className={styles.moneyCell} title={fullMoney(identifier.contractValue)}>{money(identifier.contractValue)}</td></tr>)}
      </tbody></table></div>
    </section>
    <section className={styles.drawerSection}>
      <div className={styles.drawerSectionHeader}><div><h4>Contracts using this vehicle</h4><p>Each contract is shown with its own base-and-all-options value.</p></div><span>{vehicle.contracts.length.toLocaleString()} records</span></div>
      <div className={styles.drawerTableScroll}><table className="data-table"><thead><tr><th>Contract</th><th>Requirement</th><th>Awardee</th><th>Award or order type</th><th>Date signed</th><th className={styles.moneyCell}>Total contract value</th></tr></thead><tbody>
        {vehicle.contracts.map((contract) => <tr key={`${contract.awardId}:${contract.parentAwardId}`}><td><strong>{contract.awardId}</strong></td><td>{contract.title || 'Not reported'}</td><td>{contract.contractor || 'Not reported'}</td><td>{contract.awardType || 'Not reported'}</td><td>{date(contract.dateSigned)}</td><td className={styles.moneyCell} title={fullMoney(contract.totalContractValue)}>{money(contract.totalContractValue)}</td></tr>)}
      </tbody></table></div>
    </section>
  </div>
}

export default function AgencyIntelligence() {
  const { pipeline, refresh: refreshPipeline } = usePipeline()
  const [searchParams, setSearchParams] = useSearchParams()
  const requestedAgency = useMemo(() => agencyFromParams(searchParams), [searchParams])
  const [selectedAgency, setSelectedAgency] = useState(null)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [report, setReport] = useState(null)
  const [reportCache, setReportCache] = useState('')
  const [reportLoading, setReportLoading] = useState(false)
  const [reportError, setReportError] = useState('')
  const [progress, setProgress] = useState(null)
  const [refreshVersion, setRefreshVersion] = useState(0)
  const forceRefresh = useRef(false)
  const [filter, setFilter] = useState('')
  const [page, setPage] = useState(1)
  const [selectedVehicle, setSelectedVehicle] = useState(null)
  const [idSync, setIdSync] = useState({ running: false, message: '' })
  const [exporting, setExporting] = useState(false)
  const [exportProgress, setExportProgress] = useState('')
  const [exportError, setExportError] = useState('')
  const pipelineAgencyList = useMemo(() => pipelineAgencies(pipeline), [pipeline])
  const targetGroups = useMemo(() => targetAgencyGroups(pipelineAgencyList), [pipelineAgencyList])
  const targetList = useMemo(() => targetGroups.flatMap((group) => group.agencies), [targetGroups])

  const chooseAgency = (agency) => {
    setSelectedAgency(agency)
    setFilter('')
    setPage(1)
    setSelectedVehicle(null)
    setSearchParams((current) => {
      const next = new URLSearchParams(current)
      ;[['agency', agency.name], ['tier', agency.tier], ['parent', agency.parentName], ['departmentId', agency.departmentId], ['agencyId', agency.agencyId]].forEach(([key, value]) => {
        if (value) next.set(key, value)
        else next.delete(key)
      })
      return next
    }, { replace: true })
  }

  useEffect(() => {
    const requestedName = selectedAgency?.name || requestedAgency?.name
    if (!requestedName) return
    const current = targetList.find((agency) => normalized(agency.name) === normalized(requestedName))
    if (!current) {
      if (selectedAgency) setSelectedAgency(null)
      return
    }
    if (!selectedAgency || agencyKey(current) !== agencyKey(selectedAgency)) setSelectedAgency(current)
  }, [requestedAgency, selectedAgency, targetList])

  useEffect(() => {
    if (!selectedAgency) return undefined
    const controller = new AbortController()
    let active = true
    setReportLoading(true); setReportError(''); setProgress(null); setSelectedVehicle(null)
    getAgencyVehicleReport(selectedAgency, {
      forceRefresh: forceRefresh.current,
      signal: controller.signal,
      onProgress: (next) => { if (active && next.phase !== 'complete') setProgress(next) },
    }).then((response) => {
      if (!active) return
      forceRefresh.current = false
      setReport(response.result)
      setReportCache(response.cache || '')
      setProgress(null)
    }).catch((error) => {
      if (active && error.name !== 'AbortError') setReportError(error.message)
    }).finally(() => { if (active) setReportLoading(false) })
    return () => { active = false; controller.abort() }
  }, [selectedAgency, refreshVersion])

  const refreshCurrent = () => {
    forceRefresh.current = true
    setRefreshVersion((value) => value + 1)
  }

  const exportAll = async () => {
    if (exporting) return
    setExporting(true); setExportError('')
    try {
      const reports = new Map()
      for (let index = 0; index < targetList.length; index += 1) {
        const agency = targetList[index]
        setExportProgress(`Preparing ${index + 1} of ${targetList.length}: ${agency.name}`)
        const response = await getAgencyVehicleReport(agency)
        reports.set(agency.name, response.result)
      }
      exportAgencyVehicleDocument(TARGET_AGENCY_GROUPS, reports)
      setExportProgress('Export ready')
    } catch (error) {
      setExportError(`Export could not finish: ${error.message}`)
    } finally {
      setExporting(false)
    }
  }

  const syncAgencyIds = async () => {
    if (idSync.running || pipeline.length === 0) return
    setIdSync({ running: true, message: 'Preparing ID columns…' })
    try {
      await ensureTableColumns('PipelineTable', AGENCY_ID_COLUMNS)
      await ensureTableColumns('NewOpportunitiesTable', AGENCY_ID_COLUMNS)
      const pulled = await getSAMOpportunities()
      const reference = buildSAMAgencyIdReference(pulled)
      let updated = 0; let unresolved = 0; let failed = 0
      for (let index = 0; index < pipeline.length; index += 1) {
        const opportunity = pipeline[index]
        const patch = agencyIdPatch(opportunity, reference)
        if (Object.keys(patch).length) {
          try { await updateRowWithReconciliation('PipelineTable', opportunity._rowIndex, patch); updated += 1 } catch { failed += 1 }
        } else if (!opportunity['Department ID'] || !opportunity['Agency ID']) unresolved += 1
        setIdSync({ running: true, message: `Checking ${index + 1} of ${pipeline.length}…` })
      }
      await refreshPipeline()
      setIdSync({ running: false, message: `${updated} updated${unresolved ? ` · ${unresolved} unresolved` : ''}${failed ? ` · ${failed} could not be saved` : ''}` })
    } catch (error) {
      setIdSync({ running: false, message: `ID sync failed: ${error.message}` })
    }
  }

  const filteredVehicles = useMemo(() => {
    const value = normalized(filter)
    return (report?.vehicles || []).filter((vehicle) => !value || [
      vehicle.vehicleName,
      ...(vehicle.issuingDepartments || []),
      ...(vehicle.vehicleTypes || []),
      ...(vehicle.setAsides || []),
      ...(vehicle.awardTypes || []),
      ...(vehicle.identifiers || []).flatMap((identifier) => [identifier.piid, identifier.agencyId]),
    ].some((field) => normalized(field).includes(value)))
  }, [report, filter])
  const pages = Math.max(1, Math.ceil(filteredVehicles.length / PAGE_SIZE))
  const rows = filteredVehicles.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)
  const progressPercent = progress?.total > 0
    ? Math.min(100, Math.round(((progress.phase === 'vehicles' ? progress.resolved : progress.loaded) / progress.total) * 100))
    : null
  const progressText = progress?.phase === 'vehicles'
    ? `Resolving ${Number(progress.resolved || 0).toLocaleString()} of ${Number(progress.total || 0).toLocaleString()} vehicle identifiers`
    : `${Number(progress?.loaded || 0).toLocaleString()} of ${Number(progress?.total || 0).toLocaleString()} contract records loaded`

  return <>
    <Topbar title="Agency Intelligence" subtitle1="Contract vehicle report" subtitle2="SAM.gov" showFilter={false} />
    <div className={`page-body ${styles.page}`}>
      <div className={`card ${styles.workspace} ${sidebarCollapsed ? styles.workspaceCollapsed : ''}`}>
        <aside className={`${styles.agencyPanel} ${sidebarCollapsed ? styles.agencyPanelCollapsed : ''}`}>
          <button className={styles.panelToggle} type="button" onClick={() => setSidebarCollapsed((value) => !value)} title={sidebarCollapsed ? 'Open agency list' : 'Close agency list'} aria-label={sidebarCollapsed ? 'Open agency list' : 'Close agency list'}>{sidebarCollapsed ? '›' : '‹'}</button>
          {!sidebarCollapsed && <div className={styles.agencyPanelBody}>
            <div className={styles.agencySearch}>
              <label>Target agencies</label>
              <small>This maintained list matches the target-agency report. New agencies can be added to the catalog when needed.</small>
              <div className={styles.identifierSync}><button className="btn text-sm" type="button" onClick={syncAgencyIds} disabled={idSync.running || pipeline.length === 0}>{idSync.running ? 'Syncing IDs…' : 'Sync agency IDs'}</button><span>{idSync.message || 'Backfill the existing Department ID and Agency ID columns from pulled SAM records.'}</span></div>
            </div>
            <div className={styles.agencyList}>
              <div className={styles.listHeading}><span>Included agencies</span><small>{targetList.length}</small></div>
              {targetGroups.map((group) => <section className={styles.agencyGroup} key={group.department}><h4>{group.department}</h4>{group.agencies.map((agency) => <button key={agencyKey(agency)} type="button" className={`${styles.agencyItem} ${normalized(selectedAgency?.name) === normalized(agency.name) ? styles.agencyItemActive : ''}`} onClick={() => chooseAgency(agency)}><strong>{agency.name}</strong><span>{agency.count ? `${agency.count} pipeline ${agency.count === 1 ? 'opportunity' : 'opportunities'}` : 'No pipeline opportunities'}{agency.agencyId ? ` · ${agency.agencyId}` : ''}</span></button>)}</section>)}
            </div>
          </div>}
        </aside>
        <main className={styles.detailPanel}>
          {!selectedAgency ? <div className={styles.emptyDetail}><strong>Select a target agency</strong><span>Choose an agency from the maintained list to review its named contract vehicles.</span></div> : <>
            <div className={styles.fixedSummary}>
              <header className={styles.detailHeader}><div><span className={styles.eyebrow}>{selectedAgency.tier === 'subtier' ? 'Contracting agency' : 'Contracting department'}</span><h2>{selectedAgency.name}</h2><p>{selectedAgency.tier === 'subtier' ? `${selectedAgency.parentName} · Agency ID ${selectedAgency.agencyId || 'resolved by SAM.gov name'}` : `Department ID ${selectedAgency.departmentId || 'resolved by SAM.gov name'}`}</p></div><div className={styles.headerActions}><button className="btn text-sm" type="button" onClick={exportAll} disabled={exporting}>{exporting ? 'Preparing export…' : 'Export report'}</button><button className="btn text-sm" type="button" onClick={refreshCurrent} disabled={reportLoading}>{reportLoading ? 'Refreshing…' : 'Refresh data'}</button></div></header>
              {(exportProgress || exportError) && <div className={`${styles.exportStatus} ${exportError ? styles.exportError : ''}`}>{exportError || exportProgress}</div>}
              <section className={styles.summaryCards}>
                <div><span>Named vehicles</span><strong>{reportLoading && !report ? '…' : (report?.totals?.vehicleFamilies || 0).toLocaleString()}</strong><small>Consolidated categories</small></div>
                <div><span>Contract records</span><strong>{reportLoading && !report ? '…' : (report?.totals?.contracts || 0).toLocaleString()}</strong><small>Orders with a resolved IDV</small></div>
                <div title={fullMoney(report?.totals?.totalContractValue)}><span>Total contract value</span><strong>{reportLoading && !report ? '…' : money(report?.totals?.totalContractValue)}</strong><small>Base and all options</small></div>
              </section>
            </div>
            <div className={styles.resultsScroll}>
              <section className={styles.vehicleSection}>
                <div className={styles.vehicleToolbar}><div><h3>Contract vehicles by contracting agency</h3><p>Named vehicles only, ordered by matching contract record count.</p></div><input className="form-input" value={filter} onChange={(event) => { setFilter(event.target.value); setPage(1) }} placeholder="Filter vehicle, type, set-aside, or identifier" /></div>
                {progress && <div className={styles.progressBlock}><div><span>{progress.phase === 'vehicles' ? 'Resolving vehicle names' : 'Loading SAM.gov contract records'}</span><b>{progressText}</b></div><div className={`${styles.progressTrack} ${progressPercent === null ? styles.progressTrackIndeterminate : ''}`}><span style={progressPercent === null ? undefined : { width: `${progressPercent}%` }} /></div></div>}
                {reportError ? <div className={styles.errorState}><strong>Contract vehicle report could not load</strong><span>{reportError}</span><button className="btn" type="button" onClick={() => setRefreshVersion((value) => value + 1)}>Try again</button></div> : reportLoading && !report ? <div className={styles.loadingRows}>{[1, 2, 3, 4].map((item) => <div className="skeleton" key={item} />)}</div> : rows.length === 0 ? <div className={styles.noVehicles}>No named contract vehicles were resolved for this agency in the selected five-year period.</div> : <div className={styles.tableScroll}><table className="data-table"><thead><tr><th>#</th><th>Vehicle or category</th><th>Records</th><th>Issuing department</th><th>Vehicle or IDV type(s)</th><th>Set-aside(s)</th><th>Award or order type(s)</th><th className={styles.moneyCell}>Total contract value</th></tr></thead><tbody>{rows.map((vehicle, index) => <tr key={vehicle.vehicleName} className={selectedVehicle?.vehicleName === vehicle.vehicleName ? styles.selectedRow : ''} onClick={() => setSelectedVehicle(vehicle)}><td>{(page - 1) * PAGE_SIZE + index + 1}</td><td><div className={styles.vehicleIdentity}><strong>{vehicle.vehicleName}</strong><span>{vehicle.identifierCount} {vehicle.identifierCount === 1 ? 'identifier' : 'identifiers'}</span></div></td><td>{vehicle.recordCount.toLocaleString()}</td><td>{join(vehicle.issuingDepartments)}</td><td>{join(vehicle.vehicleTypes)}</td><td>{join(vehicle.setAsides, 'Not stated')}</td><td>{join(vehicle.awardTypes)}</td><td className={styles.moneyCell} title={fullMoney(vehicle.totalContractValue)}>{money(vehicle.totalContractValue)}</td></tr>)}</tbody></table></div>}
                <div className={styles.sourceRow}><span>SAM.gov Contract Awards API · {report?.period ? `${report.period.firstYear} to ${report.period.lastYear}` : 'Last five years'} · {reportCache === 'shared' || reportCache === 'browser' ? 'quarterly cache' : 'live'}{report?.fetchedAt ? ` · Updated ${date(report.fetchedAt)}` : ''}</span><span>{[report?.excludedContracts > 0 ? `${report.excludedContracts.toLocaleString()} unnamed or non-IDV records excluded` : '', report?.unresolvedVehicleIdentifiers > 0 ? `${report.unresolvedVehicleIdentifiers.toLocaleString()} parent IDs could not be resolved` : ''].filter(Boolean).join(' · ')}</span></div>
                <div className={styles.pagination}><button className="btn" type="button" disabled={page <= 1} onClick={() => setPage((value) => value - 1)}>Previous</button><span>Page {page} of {pages}</span><button className="btn" type="button" disabled={page >= pages} onClick={() => setPage((value) => value + 1)}>Next</button></div>
              </section>
            </div>
            {selectedVehicle && <div className={styles.drawerBackdrop} onClick={() => setSelectedVehicle(null)}><aside className={styles.vehicleDrawer} onClick={(event) => event.stopPropagation()}><VehicleDetails vehicle={selectedVehicle} onClose={() => setSelectedVehicle(null)} /></aside></div>}
          </>}
        </main>
      </div>
    </div>
  </>
}
