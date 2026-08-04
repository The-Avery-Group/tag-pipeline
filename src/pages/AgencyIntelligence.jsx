import { useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import Topbar from '@/components/Layout/Topbar'
import { usePipeline } from '@/hooks/usePipeline'
import { ensureTableColumns, getSAMOpportunities, updateRow } from '@/services/graphService'
import { agencyIdPatch, buildSAMAgencyIdReference } from '@/lib/agencyIntelligence'
import {
  getAgencyVehicles,
  getVehicleActivity,
  searchOfficialAgencies,
} from '@/services/agencyIntelligenceService'
import styles from './AgencyIntelligence.module.css'

const DEPARTMENT = 'Department*'
const AGENCY = 'Agency*'
const OFFICE = 'Office*'
const AGENCY_ID_COLUMNS = ['Department ID', 'Agency ID']

function clean(value) {
  return String(value || '').trim()
}

function normalized(value) {
  return clean(value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

function money(value) {
  const number = Number(value || 0)
  if (Math.abs(number) >= 1_000_000_000) return `$${(number / 1_000_000_000).toFixed(1)}B`
  if (Math.abs(number) >= 1_000_000) return `$${(number / 1_000_000).toFixed(1)}M`
  if (Math.abs(number) >= 1_000) return `$${(number / 1_000).toFixed(1)}K`
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(number)
}

function fullMoney(value) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(Number(value || 0))
}

function date(value) {
  if (!value) return 'Not reported'
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return value
  return parsed.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function isActiveVehicle(vehicle) {
  if (!vehicle.lastDateToOrder) return false
  const end = new Date(vehicle.lastDateToOrder)
  return !Number.isNaN(end.getTime()) && end >= new Date()
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
  return [...grouped.values()]
    .map((item) => ({ ...item, offices: [...item.offices] }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
}

function agencyFromParams(params) {
  const name = clean(params.get('agency'))
  if (!name) return null
  return {
    name,
    tier: params.get('tier') === 'subtier' ? 'subtier' : 'toptier',
    parentName: clean(params.get('parent')),
    abbreviation: clean(params.get('abbr')),
    toptierCode: clean(params.get('code')),
    id: clean(params.get('id')) || null,
    departmentId: clean(params.get('departmentId')),
    agencyId: clean(params.get('agencyId')),
  }
}

function agencyLabel(agency) {
  if (!agency) return ''
  return agency.abbreviation && normalized(agency.abbreviation) !== normalized(agency.name)
    ? `${agency.name} (${agency.abbreviation})`
    : agency.name
}

function VehicleDetails({ vehicle, detail, loading, error }) {
  if (!vehicle) return null
  return (
    <section className={styles.vehicleDetail} aria-live="polite">
      <div className={styles.vehicleDetailHeader}>
        <div>
          <span className={styles.eyebrow}>Selected vehicle</span>
          <h3>{vehicle.awardId || 'Vehicle record'}</h3>
          <p>{vehicle.description || 'No description reported by USAspending.'}</p>
        </div>
        {vehicle.generatedId && (
          <a className="btn text-sm" href={`https://www.usaspending.gov/award/${encodeURIComponent(vehicle.generatedId)}`} target="_blank" rel="noreferrer">
            View on USAspending.gov
          </a>
        )}
      </div>

      <div className={styles.vehicleFacts}>
        <div><span>Contractor</span><strong>{vehicle.contractor || 'Not reported'}</strong><small>{vehicle.contractorUEI ? `UEI ${vehicle.contractorUEI}` : ''}</small></div>
        <div><span>Vehicle type</span><strong>{vehicle.vehicleType || 'Not reported'}</strong></div>
        <div><span>NAICS</span><strong>{vehicle.naicsCode || 'Not reported'}</strong><small>{vehicle.naicsDescription}</small></div>
        <div><span>PSC</span><strong>{vehicle.pscCode || 'Not reported'}</strong><small>{vehicle.pscDescription}</small></div>
        <div><span>Start date</span><strong>{date(vehicle.startDate)}</strong></div>
        <div><span>Last date to order</span><strong>{date(vehicle.lastDateToOrder)}</strong></div>
      </div>

      {loading ? (
        <div className={styles.detailLoading}>Loading order activity…</div>
      ) : error ? (
        <div className={styles.inlineError}>{error}</div>
      ) : detail ? (
        <>
          <div className={styles.activityMetrics}>
            <div><span>Orders</span><strong>{detail.totalOrderCount.toLocaleString()}</strong><small>{detail.directOrderCount.toLocaleString()} direct · {detail.nestedOrderCount.toLocaleString()} nested</small></div>
            <div><span>Child vehicles</span><strong>{detail.childVehicleCount.toLocaleString()}</strong></div>
            <div title={fullMoney(detail.totalObligations)}><span>Order obligations</span><strong>{money(detail.totalObligations)}</strong></div>
            <div title={fullMoney(detail.totalPotentialValue)}><span>Potential order value</span><strong>{money(detail.totalPotentialValue)}</strong></div>
          </div>
          {detail.displayedOrders.length > 0 && (
            <div className={styles.orderActivity}>
              <div className={styles.subsectionHeader}>
                <div><h4>Order activity</h4><p>Up to 50 highest-obligation child awards reported for this vehicle.</p></div>
                {detail.activityTruncated && <span className="badge badge-tracking">Showing 50 of {detail.activityTotal.toLocaleString()}</span>}
              </div>
              <div className={styles.tableScroll}>
                <table className="data-table">
                  <thead><tr><th>Order</th><th>Contractor</th><th>Level</th><th>Start</th><th>Potential end</th><th className={styles.moneyCell}>Obligations</th></tr></thead>
                  <tbody>{detail.displayedOrders.map((order) => (
                    <tr key={order.generatedId || `${order.awardId}:${order.contractor}`}>
                      <td>{order.awardId || 'Not reported'}</td>
                      <td>{order.contractor || 'Not reported'}</td>
                      <td>{order.grandchild ? 'Nested' : 'Direct'}</td>
                      <td>{date(order.startDate)}</td>
                      <td>{date(order.potentialEndDate)}</td>
                      <td className={styles.moneyCell} title={fullMoney(order.obligatedAmount)}>{money(order.obligatedAmount)}</td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
            </div>
          )}
        </>
      ) : null}
    </section>
  )
}

export default function AgencyIntelligence() {
  const { pipeline, refresh: refreshPipeline } = usePipeline()
  const [searchParams, setSearchParams] = useSearchParams()
  const [query, setQuery] = useState('')
  const [searchResults, setSearchResults] = useState([])
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState('')
  const [resolving, setResolving] = useState('')
  const [selectedAgency, setSelectedAgency] = useState(() => agencyFromParams(searchParams))
  const [vehicles, setVehicles] = useState([])
  const [totalVehicles, setTotalVehicles] = useState(0)
  const [page, setPage] = useState(1)
  const [hasNext, setHasNext] = useState(false)
  const [vehicleLoading, setVehicleLoading] = useState(false)
  const [vehicleError, setVehicleError] = useState('')
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

  const pipelineMatch = useMemo(() => {
    if (!selectedAgency) return null
    return pipelineAgencyList.find((item) => {
      if (
        selectedAgency.departmentId && selectedAgency.agencyId &&
        item.departmentId === selectedAgency.departmentId && item.agencyId === selectedAgency.agencyId
      ) return true
      const selectedNames = [selectedAgency.name, selectedAgency.parentName].map(normalized).filter(Boolean)
      return selectedNames.includes(normalized(item.name)) || selectedNames.includes(normalized(item.parentName))
    }) || null
  }, [pipelineAgencyList, selectedAgency])

  const filteredVehicles = useMemo(() => {
    const value = normalized(vehicleFilter)
    if (!value) return vehicles
    return vehicles.filter((vehicle) => [
      vehicle.awardId,
      vehicle.description,
      vehicle.vehicleType,
      vehicle.contractor,
      vehicle.contractorUEI,
      vehicle.awardingSubAgency,
      vehicle.naicsCode,
      vehicle.naicsDescription,
      vehicle.pscCode,
      vehicle.pscDescription,
    ].some((field) => normalized(field).includes(value)))
  }, [vehicles, vehicleFilter])

  useEffect(() => {
    const text = query.trim()
    if (text.length < 2) {
      setSearchResults([])
      setSearchError('')
      setSearching(false)
      return undefined
    }
    const requestId = ++searchRequest.current
    const controller = new AbortController()
    const timer = setTimeout(async () => {
      setSearching(true)
      setSearchError('')
      try {
        const result = await searchOfficialAgencies(text, { signal: controller.signal })
        if (requestId === searchRequest.current) setSearchResults(result.agencies || [])
      } catch (error) {
        if (error.name !== 'AbortError' && requestId === searchRequest.current) {
          setSearchError(error.message)
          setSearchResults([])
        }
      } finally {
        if (requestId === searchRequest.current) setSearching(false)
      }
    }, 300)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [query])

  const chooseAgency = (agency) => {
    setSelectedAgency(agency)
    setPage(1)
    setVehicleFilter('')
    setSelectedVehicle(null)
    setVehicleDetail(null)
    setSearchParams((current) => {
      const next = new URLSearchParams(current)
      next.set('agency', agency.name)
      next.set('tier', agency.tier)
      if (agency.parentName) next.set('parent', agency.parentName); else next.delete('parent')
      if (agency.abbreviation) next.set('abbr', agency.abbreviation); else next.delete('abbr')
      if (agency.toptierCode) next.set('code', agency.toptierCode); else next.delete('code')
      if (agency.id !== null && agency.id !== undefined && agency.id !== '') next.set('id', agency.id); else next.delete('id')
      if (agency.departmentId) next.set('departmentId', agency.departmentId); else next.delete('departmentId')
      if (agency.agencyId) next.set('agencyId', agency.agencyId); else next.delete('agencyId')
      return next
    }, { replace: true })
  }

  const resolvePipelineAgency = async (candidate) => {
    if (resolving) return
    setResolving(candidate.name)
    setSearchError('')
    try {
      let result = await searchOfficialAgencies(candidate.name)
      if (!result.agencies?.length && candidate.parentName) result = await searchOfficialAgencies(candidate.parentName)
      const matches = (result.agencies || []).filter((agency) =>
        !candidate.departmentId || agency.toptierCode === candidate.departmentId
      )
      const exact = matches.find((agency) => normalized(agency.name) === normalized(candidate.name))
      const parentExact = matches.find((agency) => normalized(agency.parentName) === normalized(candidate.parentName) && agency.tier === 'subtier')
      const match = exact || parentExact || (!candidate.departmentId ? result.agencies?.[0] : null)
      if (!match) throw new Error('No official USAspending agency match was found')
      chooseAgency({ ...match, departmentId: candidate.departmentId, agencyId: candidate.agencyId })
    } catch (error) {
      setSearchError(error.message)
    } finally {
      setResolving('')
    }
  }

  const loadVehicles = async ({ forceRefresh = false } = {}) => {
    if (!selectedAgency) return
    const controller = new AbortController()
    setVehicleLoading(true)
    setVehicleError('')
    setSelectedVehicle(null)
    setVehicleDetail(null)
    try {
      const result = await getAgencyVehicles(selectedAgency, { page, limit: 50, forceRefresh, signal: controller.signal })
      setVehicles(result.vehicles || [])
      setTotalVehicles(result.totalVehicles ?? null)
      setHasNext(Boolean(result.hasNext))
      setCacheState(result.cache || '')
      setFetchedAt(result.fetchedAt || '')
    } catch (error) {
      if (error.name !== 'AbortError') setVehicleError(error.message)
    } finally {
      setVehicleLoading(false)
    }
    return () => controller.abort()
  }

  useEffect(() => {
    let active = true
    if (!selectedAgency) return undefined
    const controller = new AbortController()
    setVehicleLoading(true)
    setVehicleError('')
    setSelectedVehicle(null)
    setVehicleDetail(null)
    getAgencyVehicles(selectedAgency, { page, limit: 50, signal: controller.signal })
      .then((result) => {
        if (!active) return
        setVehicles(result.vehicles || [])
        setTotalVehicles(result.totalVehicles ?? null)
        setHasNext(Boolean(result.hasNext))
        setCacheState(result.cache || '')
        setFetchedAt(result.fetchedAt || '')
      })
      .catch((error) => { if (active && error.name !== 'AbortError') setVehicleError(error.message) })
      .finally(() => { if (active) setVehicleLoading(false) })
    return () => { active = false; controller.abort() }
  }, [selectedAgency, page])

  const selectVehicle = async (vehicle) => {
    setSelectedVehicle(vehicle)
    setVehicleDetail(null)
    setDetailError('')
    if (!vehicle.generatedId) {
      setDetailError('USAspending did not provide the vehicle identifier needed for order activity.')
      return
    }
    setDetailLoading(true)
    try {
      setVehicleDetail(await getVehicleActivity(vehicle.generatedId))
    } catch (error) {
      setDetailError(error.message)
    } finally {
      setDetailLoading(false)
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
      let updated = 0
      let unresolved = 0
      for (let index = 0; index < pipeline.length; index += 1) {
        const opportunity = pipeline[index]
        const patch = agencyIdPatch(opportunity, reference)
        if (Object.keys(patch).length) {
          await updateRow('PipelineTable', opportunity._rowIndex, patch)
          updated += 1
        } else if (!opportunity['Department ID'] || !opportunity['Agency ID']) {
          unresolved += 1
        }
        setIdSync({ running: true, message: `Checking ${index + 1} of ${pipeline.length}…` })
      }
      await refreshPipeline()
      const hasReferenceIds = pulled.some((row) => row['Department ID'] || row['Agency ID'])
      setIdSync({
        running: false,
        message: hasReferenceIds
          ? `${updated} updated${unresolved ? ` · ${unresolved} need a matching SAM hierarchy` : ''}`
          : 'Columns are ready. Run a SAM pull, then sync again to backfill existing opportunities.',
      })
    } catch (error) {
      setIdSync({ running: false, message: `ID sync failed: ${error.message}` })
    }
  }

  const activeOnPage = vehicles.filter(isActiveVehicle).length
  const contractorsOnPage = new Set(vehicles.map((vehicle) => normalized(vehicle.contractor)).filter(Boolean)).size

  return (
    <>
      <Topbar title="Agency Intelligence" subtitle1="Federal contract vehicles" subtitle2="USAspending.gov" showFilter={false} />
      <div className={`page-body ${styles.page}`}>
        <div className={`card ${styles.workspace}`}>
          <aside className={styles.agencyPanel}>
            <div className={styles.agencySearch}>
              <label htmlFor="agency-search">Find an agency</label>
              <input id="agency-search" className="form-input" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Name, abbreviation, or component" />
              <small>Names are resolved to official USAspending agency records.</small>
              <div className={styles.identifierSync}>
                <button className="btn text-sm" type="button" onClick={syncAgencyIds} disabled={idSync.running || pipeline.length === 0}>
                  {idSync.running ? 'Syncing IDs…' : 'Sync agency IDs'}
                </button>
                <span>{idSync.message || 'Backfill Department ID and Agency ID from pulled SAM hierarchies.'}</span>
              </div>
            </div>
            {searchError && <div className={styles.searchError}>{searchError}</div>}
            {query.trim().length >= 2 ? (
              <div className={styles.agencyList}>
                <div className={styles.listHeading}><span>Official matches</span>{searching && <small>Searching…</small>}</div>
                {!searching && searchResults.length === 0 ? <p className={styles.emptyList}>No agency matches found.</p> : searchResults.map((agency) => (
                  <button key={`${agency.id}:${agency.tier}:${agency.name}`} type="button" className={`${styles.agencyItem} ${selectedAgency?.name === agency.name && selectedAgency?.tier === agency.tier ? styles.agencyItemActive : ''}`} onClick={() => chooseAgency(agency)}>
                    <strong>{agency.name}</strong>
                    <span>
                      {agency.tier === 'subtier'
                        ? `${agency.parentName} · ID ${agency.id ?? 'not reported'} · Parent code ${agency.toptierCode || 'not reported'}`
                        : `${agency.abbreviation || 'Federal agency'} · Code ${agency.toptierCode || 'not reported'} · ID ${agency.id ?? 'not reported'}`}
                    </span>
                  </button>
                ))}
              </div>
            ) : (
              <div className={styles.agencyList}>
                <div className={styles.listHeading}><span>In your pipeline</span><small>{pipelineAgencyList.length}</small></div>
                {pipelineAgencyList.length === 0 ? <p className={styles.emptyList}>No agency names are available in the pipeline.</p> : pipelineAgencyList.map((agency) => (
                  <button key={`${agency.parentName}:${agency.name}`} type="button" className={styles.agencyItem} disabled={Boolean(resolving)} onClick={() => resolvePipelineAgency(agency)}>
                    <strong>{agency.name}</strong>
                    <span>{resolving === agency.name ? 'Resolving official agency…' : `${agency.count} ${agency.count === 1 ? 'opportunity' : 'opportunities'}${agency.parentName ? ` · ${agency.parentName}` : ''}${agency.agencyId ? ` · ID ${agency.agencyId}` : ''}`}</span>
                  </button>
                ))}
              </div>
            )}
          </aside>

          <main className={styles.detailPanel}>
            {!selectedAgency ? (
              <div className={styles.emptyDetail}>
                <div>⌂</div>
                <strong>Select an agency</strong>
                <span>Choose an agency from the pipeline or search USAspending to review its contract vehicles.</span>
              </div>
            ) : (
              <div className={styles.detailContent}>
                <header className={styles.detailHeader}>
                  <div>
                    <span className={styles.eyebrow}>{selectedAgency.tier === 'subtier' ? 'Subagency' : 'Federal agency'}</span>
                    <h2>{agencyLabel(selectedAgency)}</h2>
                    <p>
                      {selectedAgency.tier === 'subtier'
                        ? `${selectedAgency.parentName} · USAspending ID ${selectedAgency.id ?? 'not reported'} · Parent code ${selectedAgency.toptierCode || 'not reported'}`
                        : `Agency code ${selectedAgency.toptierCode || 'not reported'} · USAspending ID ${selectedAgency.id ?? 'not reported'}`}
                      {pipelineMatch ? ` · ${pipelineMatch.count} pipeline ${pipelineMatch.count === 1 ? 'opportunity' : 'opportunities'}` : ''}
                    </p>
                  </div>
                  <button className="btn text-sm" type="button" onClick={() => loadVehicles({ forceRefresh: true })} disabled={vehicleLoading}>{vehicleLoading ? 'Refreshing…' : 'Refresh data'}</button>
                </header>

                {vehicleError ? (
                  <div className={styles.errorState}><strong>Vehicle data could not load</strong><span>{vehicleError}</span><button className="btn" type="button" onClick={() => loadVehicles()}>Try again</button></div>
                ) : (
                  <>
                    <section className={styles.summaryCards}>
                      <div><span>Vehicle records</span><strong>{vehicleLoading ? '…' : totalVehicles === null ? 'Not available' : totalVehicles.toLocaleString()}</strong><small>{totalVehicles === null ? 'Vehicle rows are still available' : 'Official IDV count'}</small></div>
                      <div><span>Shown</span><strong>{vehicleLoading ? '…' : vehicles.length.toLocaleString()}</strong><small>Page {page}</small></div>
                      <div><span>Active shown</span><strong>{vehicleLoading ? '…' : activeOnPage.toLocaleString()}</strong><small>Last order date has not passed</small></div>
                      <div><span>Contractors shown</span><strong>{vehicleLoading ? '…' : contractorsOnPage.toLocaleString()}</strong><small>Unique recipients on this page</small></div>
                    </section>

                    <section className={styles.vehicleSection}>
                      <div className={styles.vehicleToolbar}>
                        <div><h3>Contract vehicles</h3><p>Most recently updated records appear first.</p></div>
                        <input className="form-input" value={vehicleFilter} onChange={(event) => setVehicleFilter(event.target.value)} placeholder="Filter these 50 records" />
                      </div>
                      <div className={styles.sourceRow}>
                        <span>USAspending.gov · {cacheState === 'cache' ? 'cached' : 'live'}{fetchedAt ? ` · Updated ${date(fetchedAt)}` : ''}</span>
                        <span>{filteredVehicles.length} shown</span>
                      </div>
                      {vehicleLoading ? (
                        <div className={styles.loadingRows}>{[1, 2, 3, 4].map((item) => <div className="skeleton" key={item} />)}</div>
                      ) : vehicles.length === 0 ? (
                        <div className={styles.noVehicles}>No IDV records were returned for this agency.</div>
                      ) : filteredVehicles.length === 0 ? (
                        <div className={styles.noVehicles}>No vehicles on this page match that filter.</div>
                      ) : (
                        <div className={styles.tableScroll}>
                          <table className="data-table">
                            <thead><tr><th>Vehicle</th><th>Contractor</th><th>Type</th><th>Awarding component</th><th>Last date to order</th><th className={styles.moneyCell}>Award amount</th></tr></thead>
                            <tbody>{filteredVehicles.map((vehicle) => (
                              <tr key={vehicle.generatedId || vehicle.awardId} className={selectedVehicle?.generatedId === vehicle.generatedId ? styles.selectedRow : ''} onClick={() => selectVehicle(vehicle)}>
                                <td><div className={styles.vehicleIdentity}><strong>{vehicle.awardId || 'No award ID'}</strong><span title={vehicle.description}>{vehicle.description || 'No description reported'}</span></div></td>
                                <td><div className={styles.vehicleIdentity}><strong>{vehicle.contractor || 'Not reported'}</strong><span>{vehicle.contractorUEI || ''}</span></div></td>
                                <td>{vehicle.vehicleType || 'Not reported'}</td>
                                <td>{vehicle.awardingSubAgency || vehicle.awardingAgency || 'Not reported'}</td>
                                <td><span className={isActiveVehicle(vehicle) ? styles.activeDate : ''}>{date(vehicle.lastDateToOrder)}</span></td>
                                <td className={styles.moneyCell} title={fullMoney(vehicle.awardAmount)}>{money(vehicle.awardAmount)}</td>
                              </tr>
                            ))}</tbody>
                          </table>
                        </div>
                      )}
                      <div className={styles.pagination}>
                        <button className="btn" type="button" disabled={page <= 1 || vehicleLoading} onClick={() => setPage((current) => Math.max(1, current - 1))}>Previous</button>
                        <span>Page {page}</span>
                        <button className="btn" type="button" disabled={!hasNext || vehicleLoading} onClick={() => setPage((current) => current + 1)}>Next</button>
                      </div>
                    </section>

                    <VehicleDetails vehicle={selectedVehicle} detail={vehicleDetail} loading={detailLoading} error={detailError} />
                  </>
                )}
              </div>
            )}
          </main>
        </div>
      </div>
    </>
  )
}
