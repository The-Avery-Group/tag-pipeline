import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
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

export default function ExpiringContractDiscovery({ pipeline, contacts = [], add, openOpportunity, pipelineView, search, toast }) {
  const navigate = useNavigate()
  const [view, setView] = useState('pipeline')
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
  } = useExpiringContracts(range, selectedAgencyIds, showHidden)

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
