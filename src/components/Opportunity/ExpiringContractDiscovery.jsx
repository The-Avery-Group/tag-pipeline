import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useExpiringContracts } from '@/hooks/useExpiringContracts'
import { formatDate } from '@/utils/kpiHelpers'
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

function DetailField({ label, value, link }) {
  return (
    <div className={styles.detailField}>
      <span>{label}</span>
      {link && value
        ? <a href={link} target="_blank" rel="noreferrer">{value}</a>
        : <strong>{value || 'Not available'}</strong>}
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
        {match.sourceLink && <a className={styles.matchSource} href={match.sourceLink} target="_blank" rel="noreferrer">Matched from {match.noticeId || 'public notice'}</a>}
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
          <option value="">Choose a public match</option>
          {resolution.matches.map((match, index) => <option key={`${match.email}-${match.noticeId}`} value={String(index)}>{match.name || match.email} · {match.noticeId || 'public notice'}</option>)}
        </select>
        {selected?.sourceLink && <a className={styles.matchSource} href={selected.sourceLink} target="_blank" rel="noreferrer">Matched from {selected.noticeId || 'public notice'}</a>}
      </div>
    )
  }
  return <span>{resolution.raw}<small className={styles.matchSource}>No public name match found</small></span>
}

export default function ExpiringContractDiscovery({ pipeline, add, openOpportunity, pipelineView, search, toast }) {
  const navigate = useNavigate()
  const [view, setView] = useState('pipeline')
  const [range, setRange] = useState('6-12')
  const [selectedAgencyIds, setSelectedAgencyIds] = useState([])
  const [agencyMenuOpen, setAgencyMenuOpen] = useState(false)
  const [customAgency, setCustomAgency] = useState('')
  const [customAgencies, setCustomAgencies] = useState([])
  const [expanded, setExpanded] = useState(new Set())
  const [details, setDetails] = useState({})
  const [detailLoading, setDetailLoading] = useState(new Set())
  const [addingKey, setAddingKey] = useState('')
  const [modifierChoices, setModifierChoices] = useState({})
  const { config, contracts, status, loading, error, refresh, loadDetail } = useExpiringContracts(range, selectedAgencyIds)

  const agencies = useMemo(() => {
    const byId = new Map((config.agencies || []).map((agency) => [agency.id, agency]))
    customAgencies.forEach((agency) => byId.set(agency.id, agency))
    return [...byId.values()]
  }, [config.agencies, customAgencies])
  const effectiveAgencyIds = selectedAgencyIds.length ? selectedAgencyIds : agencies.filter((agency) => !agency.custom).map((agency) => agency.id)
  const selectedAgencies = agencies.filter((agency) => effectiveAgencyIds.includes(agency.id))
  const pipelineById = useMemo(() => new Map(pipeline.map((opportunity) => [String(opportunity[C.id] || '').trim().toUpperCase(), opportunity])), [pipeline])
  const visibleContracts = useMemo(() => {
    const needle = String(search || '').trim().toLowerCase()
    if (!needle) return contracts
    return contracts.filter((contract) => Object.values(contract).some((value) => String(value || '').toLowerCase().includes(needle)))
  }, [contracts, search])

  const toggleAgency = (id) => {
    setSelectedAgencyIds((current) => {
      const base = current.length ? current : agencies.filter((agency) => !agency.custom).map((agency) => agency.id)
      return base.includes(id) ? base.filter((value) => value !== id) : [...base, id]
    })
  }

  const runRefresh = async () => {
    try {
      await refresh(selectedAgencies.length ? selectedAgencies : agencies.filter((agency) => !agency.custom))
      toast?.success('Expiring contract refresh started')
    } catch (nextError) {
      toast?.error(`Could not start refresh: ${nextError.message}`)
    }
  }

  const addCustomAgency = () => {
    const value = customAgency.trim()
    if (!value) return
    const id = `custom-${value.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`
    const custom = { id, label: value, searchName: value, tier: 'subtier', custom: true }
    setCustomAgencies((current) => current.some((agency) => agency.id === id) ? current : [...current, custom])
    setSelectedAgencyIds((current) => {
      const base = current.length ? current : agencies.filter((agency) => !agency.custom).map((agency) => agency.id)
      return [...new Set([...base, id])]
    })
    setCustomAgency('')
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

  const progress = status.currentPages
    ? Math.min(99, Math.round(((status.agencyIndex + (status.currentPage / status.currentPages)) / Math.max(1, status.agencyTotal)) * 100))
    : Math.min(95, Math.round((status.agencyIndex / Math.max(1, status.agencyTotal)) * 100))

  return (
    <div className={styles.workspace}>
      <div className={styles.viewTabs} role="tablist" aria-label="Expiring contract views">
        <button type="button" role="tab" aria-selected={view === 'pipeline'} className={view === 'pipeline' ? styles.activeView : ''} onClick={() => setView('pipeline')}>Pipeline contracts</button>
        <button type="button" role="tab" aria-selected={view === 'discover'} className={view === 'discover' ? styles.activeView : ''} onClick={() => setView('discover')}>Discover from SAM.gov</button>
      </div>

      {view === 'pipeline' ? pipelineView : (
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
            <div className={styles.agencyControl}>
              <span>Agencies</span>
              <button type="button" className={styles.agencyPicker} onClick={() => setAgencyMenuOpen((current) => !current)}>
                {selectedAgencies.length === agencies.length ? 'Default agencies' : `${selectedAgencies.length} selected`}
                <span>⌄</span>
              </button>
              {agencyMenuOpen && (
                <div className={styles.agencyMenu}>
                  {agencies.map((agency) => (
                    <label key={agency.id}>
                      <input type="checkbox" checked={effectiveAgencyIds.includes(agency.id)} onChange={() => toggleAgency(agency.id)} />
                      <span>{agency.label}</span>
                      {agency.custom && <small>Custom</small>}
                    </label>
                  ))}
                  <div className={styles.customAgency}>
                    <input value={customAgency} onChange={(event) => setCustomAgency(event.target.value)} placeholder="Add another official agency name" onKeyDown={(event) => { if (event.key === 'Enter') addCustomAgency() }} />
                    <button type="button" onClick={addCustomAgency}>Add</button>
                  </div>
                </div>
              )}
            </div>
            <button type="button" className="btn btn-primary" onClick={runRefresh} disabled={['queued', 'running'].includes(status.status)}>
              {['queued', 'running'].includes(status.status) ? 'Refreshing…' : 'Refresh contracts'}
            </button>
          </div>

          {['queued', 'running'].includes(status.status) && (
            <div className={styles.progressPanel}>
              <div><strong>Refreshing expiring contracts</strong><span>{status.currentAgency || 'Preparing'}{status.currentPages ? ` · page ${status.currentPage} of ${status.currentPages}` : ''}</span></div>
              <div className={styles.progressTrack}><span style={{ width: `${progress}%` }} /></div>
            </div>
          )}

          <div className={styles.summaryRow}>
            <strong>{visibleContracts.length} contract{visibleContracts.length === 1 ? '' : 's'}</strong>
            <span>{status.refreshedAt ? `Refreshed ${new Date(status.refreshedAt).toLocaleString()}` : 'Not refreshed yet'}</span>
          </div>
          {error && <div className={styles.errorCallout}>{error}</div>}

          <div className={styles.tableCard}>
            {loading ? <div className={styles.loading}>Loading expiring contracts…</div> : visibleContracts.length === 0 ? (
              <div className={styles.empty}>No eligible contracts are available for this range and agency selection.</div>
            ) : (
              <div className={styles.tableScroll}>
                <table className="data-table">
                  <thead><tr>
                    <th>Contract</th><th>Agency and office</th><th>Incumbent</th><th>NAICS</th><th>Ultimate completion</th><th>Total value</th><th>Actions</th><th aria-label="Contract details" />
                  </tr></thead>
                  <tbody>
                    {visibleContracts.map((contract) => {
                      const existing = pipelineById.get(String(contract.piid || '').toUpperCase())
                      const isOpen = expanded.has(contract.familyKey)
                      const detail = details[contract.familyKey] || contract
                      return [
                        <tr key={contract.familyKey}>
                          <td><strong>{contract.title || contract.piid}</strong><small>{contract.piid}</small></td>
                          <td><span>{contract.agency || 'Not available'}</span><small>{contract.office || contract.department || ''}</small></td>
                          <td><span>{contract.incumbentName || 'Not available'}</span><small>{contract.incumbentUEI || ''}</small></td>
                          <td>{contract.naicsCode || 'Not available'}</td>
                          <td>{contract.ultimateCompletionDate ? formatDate(contract.ultimateCompletionDate) : 'Not available'}</td>
                          <td title={fullMoney(contract.totalContractValue)}>{compactMoney(contract.totalContractValue)}</td>
                          <td>
                            <div className={styles.actions}>
                              {existing
                                ? <button type="button" className={styles.pipelineButton} onClick={() => openOpportunity(existing)}>View in pipeline</button>
                                : <button type="button" className={styles.pipelineButton} disabled={addingKey === contract.familyKey} onClick={() => handleAdd(contract)}>{addingKey === contract.familyKey ? 'Adding…' : 'Add to pipeline'}</button>}
                              {contract.samLink && <a className={styles.samButton} href={contract.samLink} target="_blank" rel="noreferrer">SAM.gov</a>}
                            </div>
                          </td>
                          <td><button type="button" className={styles.expandButton} title={isOpen ? 'Collapse contract details' : 'Expand contract details'} aria-expanded={isOpen} onClick={() => toggleDetails(contract)}>{isOpen ? '⌃' : '⌄'}</button></td>
                        </tr>,
                        isOpen && <tr key={`${contract.familyKey}-detail`} className={styles.detailRow}><td colSpan="8">
                          {detailLoading.has(contract.familyKey) ? <div className={styles.loading}>Loading award family and public contacts…</div> : (
                            <div className={styles.detailPanel}>
                              <section><h4>Contract identity</h4><div className={styles.detailGrid}>
                                <DetailField label="PIID" value={detail.piid} />
                                <DetailField label="Contract classification" value={detail.awardType} />
                                <DetailField label="Solicitation number" value={detail.solicitationNumber} />
                                <DetailField label="Referenced IDV" value={detail.referencedIdvPiid} />
                              </div></section>
                              <section><h4>Agency and scope</h4><div className={styles.detailGrid}>
                                <DetailField label="Department" value={detail.department} />
                                <DetailField label="Agency" value={detail.agency} />
                                <DetailField label="Contracting office" value={detail.office} />
                                <DetailField label="NAICS" value={detail.naicsCode} />
                                <DetailField label="Description" value={detail.description} />
                              </div></section>
                              <section><h4>Incumbent and value</h4><div className={styles.detailGrid}>
                                <DetailField label="Incumbent" value={detail.incumbentName} />
                                <DetailField label="UEI" value={detail.incumbentUEI} />
                                <DetailField label="Total base and all options" value={fullMoney(detail.totalContractValue)} />
                                <DetailField label="Set-aside" value={detail.setAside} />
                              </div></section>
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
                                        <td><ModifierIdentity resolution={modification.modifierResolution || { raw: modification.lastModifiedBy, status: 'unresolved' }} choice={modifierChoices[choiceKey]} onChoose={(value) => setModifierChoices((current) => ({ ...current, [choiceKey]: value }))} /></td>
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
