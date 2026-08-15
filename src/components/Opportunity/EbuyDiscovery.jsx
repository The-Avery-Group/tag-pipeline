import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useEbuyOpportunities } from '@/hooks/useEbuyOpportunities'
import { ebuyToPipelineRecord, reconcileEbuyPipeline } from '@/services/ebuyService'
import EbuySyncProgress from '@/components/Common/EbuySyncProgress'
import DiscoveryToolbar, { DiscoverySelectionBar } from '@/components/Opportunity/DiscoveryToolbar'
import { formatEbuyDateTime } from '@/utils/ebuyHelpers'
import { samTypeMatches } from '@/utils/samOpportunityHelpers'
import styles from './EbuyDiscovery.module.css'

const listScrollPositions = new Map()
const listViewState = { type: 'All', departments: [] }

function singleLine(value) { return String(value || '').replace(/\s+/g, ' ').trim() }

function reviewLabel(value) {
  return ({ added_to_pipeline: 'In pipeline', tracked: 'Tracked', dismissed: 'Dismissed', flagged: 'Flagged' })[value] || ''
}

export default function EbuyDiscovery({ search, pipeline, pipelineLoading = false, includeDismissed = false, add, toast, onCountChange }) {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const [type, setType] = useState(() => listViewState.type)
  const [departments, setDepartments] = useState(() => {
    try {
      const saved = localStorage.getItem('ebuy_dept_filter_selection')
      return new Set(saved ? JSON.parse(saved) : listViewState.departments)
    } catch { return new Set(listViewState.departments) }
  })
  const [controlsOpen, setControlsOpen] = useState(false)
  const [selectionMode, setSelectionMode] = useState(false)
  const [selectedRows, setSelectedRows] = useState(new Set())
  const [bulkProgress, setBulkProgress] = useState(null)
  const [actioning, setActioning] = useState(new Set())
  const actionRef = useRef(new Set())
  const tableRef = useRef(null)
  const reconciliationRef = useRef(null)
  const archive = useEbuyOpportunities({ search, type: 'all', includeDismissed })
  const pipelineIds = useMemo(() => new Set(pipeline.map((item) => String(item['Contract Number / Notice ID'] || '').trim().toLowerCase())), [pipeline])
  const pipelineSnapshot = useMemo(() => pipeline.map((item) => ({
    id: String(item['Contract Number / Notice ID'] || '').trim(),
    outlook: String(item['Opportunity Outlook'] || '').trim(),
  })).filter((item) => item.id), [pipeline])
  const reconciliationKey = useMemo(() => pipelineSnapshot
    .map((item) => `${item.id.toLowerCase()}:${item.outlook.toLowerCase()}`).sort().join('|'), [pipelineSnapshot])
  const availableDepartments = useMemo(() => [...new Set(archive.opportunities
    .map((item) => String(item.buyerDepartment || item.buyerAgency || '').trim())
    .filter(Boolean))].sort(), [archive.opportunities])
  const visibleOpportunities = useMemo(() => archive.opportunities.filter((item) => {
    if (!includeDismissed && item.reviewState === 'dismissed') return false
    if (!samTypeMatches({ 'Notice Type': item.requestType }, type)) return false
    const department = String(item.buyerDepartment || item.buyerAgency || '').trim()
    return departments.size === 0 || departments.has(department)
  }), [archive.opportunities, departments, includeDismissed, type])
  const scrollKey = `${searchParams.toString()}|${type}|${[...departments].sort().join(',')}|${includeDismissed}`
  useEffect(() => { onCountChange?.(visibleOpportunities.length) }, [onCountChange, visibleOpportunities.length])
  useEffect(() => {
    Object.assign(listViewState, { type, departments: [...departments] })
    try { localStorage.setItem('ebuy_dept_filter_selection', JSON.stringify([...departments])) } catch {}
  }, [departments, type])

  useEffect(() => {
    if (pipelineLoading || reconciliationRef.current === reconciliationKey) return
    reconciliationRef.current = reconciliationKey
    reconcileEbuyPipeline(pipelineSnapshot)
      .then((result) => { if (result.changed) return archive.refresh({ silent: true }); return null })
      .catch((error) => console.warn('[eBuy] Pipeline state reconciliation will retry:', error.message))
  }, [archive.refresh, pipelineLoading, pipelineSnapshot, reconciliationKey])

  useLayoutEffect(() => {
    const saved = listScrollPositions.get(scrollKey)
    const element = tableRef.current
    if (!element || saved == null) return
    const frame = requestAnimationFrame(() => { element.scrollTop = saved })
    return () => cancelAnimationFrame(frame)
  }, [archive.loading, visibleOpportunities.length, scrollKey])

  const withAction = async (requestId, action) => {
    if (actionRef.current.has(requestId)) return
    actionRef.current.add(requestId)
    setActioning(new Set(actionRef.current))
    try { return await action() } finally {
      actionRef.current.delete(requestId)
      setActioning(new Set(actionRef.current))
    }
  }

  const openDetail = (opportunity) => {
    if (tableRef.current) listScrollPositions.set(scrollKey, tableRef.current.scrollTop)
    const returnTo = `/opportunities?${searchParams.toString()}`
    navigate(`/opportunities/ebuy/${encodeURIComponent(opportunity.requestId)}?returnTo=${encodeURIComponent(returnTo)}`)
  }

  const addToPipeline = (opportunity, outlook, { silent = false } = {}) => withAction(opportunity.requestId, async () => {
    let saved = null
    try {
      saved = await add(ebuyToPipelineRecord(opportunity, outlook))
    } catch (error) {
      if (!silent) toast?.error(`Could not add this eBuy opportunity: ${error.message}`)
      return false
    }
    try {
      await archive.updateState(opportunity.requestId, outlook === 'Tracking' ? 'tracked' : 'added_to_pipeline', saved['Contract Number / Notice ID'])
      if (!silent) toast?.success(outlook === 'Tracking' ? 'Added to Tracking' : 'Added to pipeline')
      return true
    } catch (error) {
      if (!silent) toast?.error(`Added to the pipeline, but the eBuy archive status could not update: ${error.message}`)
      return false
    }
  })

  const changeState = (opportunity, nextState, { silent = false, confirmed = false } = {}) => withAction(opportunity.requestId, async () => {
    if (nextState === 'dismissed' && opportunity.reviewState === 'flagged' && !confirmed && !window.confirm(`This eBuy opportunity is flagged. Dismiss "${opportunity.title}" anyway?`)) return false
    try {
      await archive.updateState(opportunity.requestId, nextState)
      return true
    } catch (error) {
      if (!silent) toast?.error(error.message)
      return false
    }
  })

  const selectedOpportunities = visibleOpportunities.filter((item) => selectedRows.has(item.requestId))
  const selectedAddable = selectedOpportunities.filter((item) => !pipelineIds.has(item.requestId.toLowerCase()) && !['tracked', 'added_to_pipeline'].includes(item.reviewState))
  const selectedDismissible = selectedOpportunities.filter((item) => item.reviewState !== 'dismissed')

  const runBulkAction = async (kind) => {
    if (bulkProgress) return
    const rows = kind === 'dismiss' ? selectedDismissible : selectedAddable
    if (!rows.length) return
    if (kind === 'dismiss') {
      const flagged = rows.filter((item) => item.reviewState === 'flagged').length
      if (flagged && !window.confirm(`${flagged} flagged opportunit${flagged === 1 ? 'y is' : 'ies are'} included. Dismiss ${flagged === 1 ? 'it' : 'them'} anyway?`)) return
    }
    setBulkProgress({ kind, completed: 0, total: rows.length })
    let failed = 0
    for (const [index, opportunity] of rows.entries()) {
      const succeeded = kind === 'dismiss'
        ? await changeState(opportunity, 'dismissed', { silent: true, confirmed: true })
        : await addToPipeline(opportunity, kind === 'track' ? 'Tracking' : 'New', { silent: true })
      if (!succeeded) failed++
      setBulkProgress({ kind, completed: index + 1, total: rows.length })
    }
    const completed = rows.length - failed
    setBulkProgress(null)
    setSelectedRows(new Set())
    setSelectionMode(false)
    const label = kind === 'dismiss' ? 'dismissed' : kind === 'track' ? 'added to Tracking' : 'added to pipeline'
    if (completed) toast?.success(`${completed} opportunit${completed === 1 ? 'y' : 'ies'} ${label}`)
    if (failed) toast?.error(`${failed} opportunit${failed === 1 ? 'y' : 'ies'} could not be updated.`)
  }

  const lastSync = archive.status?.lastSync
  const lastSyncChanges = Number(lastSync?.inserted_count || 0) + Number(lastSync?.updated_count || 0)

  return (
    <section className={styles.workspace} aria-label="GSA eBuy opportunities">
      <DiscoveryToolbar
        count={visibleOpportunities.length}
        type={type}
        onTypeChange={(value) => { setType(value); setSelectedRows(new Set()) }}
        departments={availableDepartments}
        selectedDepartments={departments}
        onDepartmentToggle={(department) => setDepartments((current) => {
          const next = new Set(current)
          next.has(department) ? next.delete(department) : next.add(department)
          setSelectedRows(new Set())
          return next
        })}
        onDepartmentClear={() => { setDepartments(new Set()); setSelectedRows(new Set()) }}
        status={lastSync?.completed_at
          ? <>Last synced: {new Date(lastSync.completed_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true })}{lastSyncChanges ? ` · ${Number(lastSync.inserted_count || 0)} new · ${Number(lastSync.updated_count || 0)} updated` : ' · No changes'}</>
          : 'Opportunity sync has not run yet'}
        controlsOpen={controlsOpen}
        onControlsToggle={() => setControlsOpen((value) => !value)}
        selectionMode={selectionMode}
        onSelectionToggle={() => { setSelectionMode((value) => !value); setSelectedRows(new Set()) }}
        selectionDisabled={archive.syncing || Boolean(bulkProgress)}
      >
          <button className="btn btn-primary" onClick={() => archive.synchronize().then((result) => toast?.success(result.alreadyRunning ? 'eBuy synchronization is already running' : 'eBuy synchronization started')).catch((error) => toast?.error(error.message))} disabled={archive.syncing}>
            {archive.syncing ? 'Synchronizing…' : 'Synchronize'}
          </button>
          <button className="btn" onClick={() => archive.refresh()} disabled={archive.loading}>Refresh</button>
      </DiscoveryToolbar>

      <EbuySyncProgress run={archive.status?.lastSync} />

      {bulkProgress && <div className={styles.bulkProgress}>
        <div><span>{bulkProgress.kind === 'dismiss' ? 'Dismissing opportunities' : bulkProgress.kind === 'track' ? 'Adding to tracking' : 'Adding to pipeline'}</span><span>{bulkProgress.completed} of {bulkProgress.total}</span></div>
        <div className={styles.bulkProgressTrack}><span style={{ width: `${Math.round((bulkProgress.completed / bulkProgress.total) * 100)}%` }} /></div>
      </div>}
      {selectionMode && !bulkProgress && <DiscoverySelectionBar count={selectedRows.size}>
        <button className={`${styles.bulkAction} ${styles.pipeline}`} disabled={!selectedAddable.length} onClick={() => runBulkAction('pipeline')}>Add to pipeline</button>
        <button className={`${styles.bulkAction} ${styles.track}`} disabled={!selectedAddable.length} onClick={() => runBulkAction('track')}>Track</button>
        <button className={`${styles.bulkAction} ${styles.dismiss}`} disabled={!selectedDismissible.length} onClick={() => runBulkAction('dismiss')}>Dismiss</button>
      </DiscoverySelectionBar>}

      {archive.error && <div className={styles.error}><strong>eBuy archive could not load</strong><span>{archive.error.message}</span></div>}
      {archive.loading ? <div className={styles.loading}><div className="skeleton" /><div className="skeleton" /><div className="skeleton" /></div> : (
        <div ref={tableRef} className={styles.tableWrap} onScroll={(event) => listScrollPositions.set(scrollKey, event.currentTarget.scrollTop)}>
          <table className={`data-table ${styles.table}`}>
            <thead><tr>{selectionMode && <th className={styles.checkCell}><input type="checkbox"
              checked={visibleOpportunities.length > 0 && visibleOpportunities.every((item) => selectedRows.has(item.requestId))}
              onChange={(event) => setSelectedRows(event.target.checked ? new Set(visibleOpportunities.map((item) => item.requestId)) : new Set())}
              aria-label="Select all visible eBuy opportunities"
            /></th>}<th>Opportunity</th><th>Type</th><th>Request ID</th><th>Agency</th><th>Set aside</th><th>Contract</th><th>Amendment</th><th>Posted</th><th>Closes</th><th>Actions</th></tr></thead>
            <tbody>
              {visibleOpportunities.map((opportunity) => {
                const busy = actioning.has(opportunity.requestId)
                const inPipeline = pipelineIds.has(opportunity.requestId.toLowerCase()) || ['tracked', 'added_to_pipeline'].includes(opportunity.reviewState)
                return <tr key={opportunity.requestId}>
                  {selectionMode && <td className={styles.checkCell}><input type="checkbox" checked={selectedRows.has(opportunity.requestId)} onChange={(event) => setSelectedRows((current) => {
                    const next = new Set(current)
                    event.target.checked ? next.add(opportunity.requestId) : next.delete(opportunity.requestId)
                    return next
                  })} aria-label={`Select ${singleLine(opportunity.title) || opportunity.requestId}`} /></td>}
                  <td>
                    <div className={styles.titleCell}>
                    <button className={`${styles.flag} ${opportunity.reviewState === 'flagged' ? styles.flagActive : ''}`} title={opportunity.reviewState === 'flagged' ? 'Remove team flag' : 'Flag for the team'} onClick={() => changeState(opportunity, opportunity.reviewState === 'flagged' ? 'new' : 'flagged')} disabled={busy} aria-label="Toggle flag">⚑</button>
                    <button className={styles.title} onClick={() => openDetail(opportunity)}>{singleLine(opportunity.title) || opportunity.requestId}</button>
                    {reviewLabel(opportunity.reviewState) && <span className={styles.state}>{reviewLabel(opportunity.reviewState)}</span>}
                    </div>
                  </td>
                  <td><span className={styles.typeBadge}>{opportunity.requestType || 'Other'}</span></td>
                  <td className={styles.mono}>{opportunity.requestId}</td><td><span className={styles.agency}>{opportunity.buyerAgency || 'Not provided'}</span>{opportunity.buyerDepartment && opportunity.buyerDepartment !== opportunity.buyerAgency && <small>{opportunity.buyerDepartment}</small>}</td>
                  <td>{opportunity.setAsideType || 'Not provided'}</td><td>{opportunity.vehiclePairs?.join(', ') || opportunity.vehicleSources?.join(', ') || 'Not provided'}</td>
                  <td>{Number(opportunity.amendmentCount || opportunity.amendments?.length || 0) > 0 ? <span className={styles.amendment}>Yes · {Number(opportunity.amendmentCount || opportunity.amendments?.length)}</span> : <span className={styles.noAmendment}>No</span>}</td>
                  <td className={styles.dateCell}>{formatEbuyDateTime(opportunity.postedAt)}</td><td className={styles.dateCell}>{formatEbuyDateTime(opportunity.closesAt)}</td>
                  <td><div className={styles.actions}>
                    {inPipeline
                      ? <button className={`${styles.action} ${styles.pipeline}`} onClick={() => openDetail(opportunity)}>View details</button>
                      : <button className={`${styles.action} ${styles.pipeline}`} onClick={() => addToPipeline(opportunity, 'New')} disabled={busy}>+ Pipeline</button>}
                    <button className={`${styles.action} ${styles.track}`} onClick={() => addToPipeline(opportunity, 'Tracking')} disabled={busy || inPipeline}>Track</button>
                    {opportunity.reviewState === 'dismissed'
                      ? <button className={`${styles.action} ${styles.restore}`} onClick={() => changeState(opportunity, 'new')} disabled={busy}>Restore</button>
                      : <button className={`${styles.action} ${styles.dismiss}`} onClick={() => changeState(opportunity, 'dismissed')} disabled={busy}>Dismiss</button>}
                    <button className={`${styles.action} ${styles.details}`} onClick={() => openDetail(opportunity)}>Details</button>
                  </div></td>
                </tr>
              })}
              {!visibleOpportunities.length && !archive.error && <tr><td colSpan={selectionMode ? 11 : 10} className={styles.empty}>No eBuy opportunities match this view.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
