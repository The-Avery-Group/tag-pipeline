import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useEbuyOpportunities } from '@/hooks/useEbuyOpportunities'
import { ebuyToPipelineRecord, reconcileEbuyPipeline } from '@/services/ebuyService'
import EbuySyncProgress from '@/components/Common/EbuySyncProgress'
import { formatEbuyDateTime } from '@/utils/ebuyHelpers'
import styles from './EbuyDiscovery.module.css'

const listScrollPositions = new Map()
const listViewState = { type: 'all', state: 'all', includeDismissed: false }

function singleLine(value) { return String(value || '').replace(/\s+/g, ' ').trim() }

function reviewLabel(value) {
  return ({ added_to_pipeline: 'In pipeline', tracked: 'Tracked', dismissed: 'Dismissed', flagged: 'Flagged' })[value] || ''
}

export default function EbuyDiscovery({ search, pipeline, pipelineLoading = false, add, toast, onCountChange }) {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const [type, setType] = useState(() => listViewState.type)
  const [state, setState] = useState(() => listViewState.state)
  const [includeDismissed, setIncludeDismissed] = useState(() => listViewState.includeDismissed)
  const [actioning, setActioning] = useState(new Set())
  const actionRef = useRef(new Set())
  const tableRef = useRef(null)
  const reconciliationRef = useRef(null)
  const archive = useEbuyOpportunities({ search, type, state, includeDismissed })
  const pipelineIds = useMemo(() => new Set(pipeline.map((item) => String(item['Contract Number / Notice ID'] || '').trim().toLowerCase())), [pipeline])
  const pipelineSnapshot = useMemo(() => pipeline.map((item) => ({
    id: String(item['Contract Number / Notice ID'] || '').trim(),
    outlook: String(item['Opportunity Outlook'] || '').trim(),
  })).filter((item) => item.id), [pipeline])
  const reconciliationKey = useMemo(() => pipelineSnapshot
    .map((item) => `${item.id.toLowerCase()}:${item.outlook.toLowerCase()}`).sort().join('|'), [pipelineSnapshot])
  const scrollKey = `${searchParams.toString()}|${type}|${state}|${includeDismissed}`
  useEffect(() => { onCountChange?.(archive.total) }, [archive.total, onCountChange])
  useEffect(() => {
    Object.assign(listViewState, { type, state, includeDismissed })
  }, [includeDismissed, state, type])

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
  }, [archive.loading, archive.opportunities.length, scrollKey])

  const withAction = async (requestId, action) => {
    if (actionRef.current.has(requestId)) return
    actionRef.current.add(requestId)
    setActioning(new Set(actionRef.current))
    try { await action() } finally {
      actionRef.current.delete(requestId)
      setActioning(new Set(actionRef.current))
    }
  }

  const openDetail = (opportunity) => {
    if (tableRef.current) listScrollPositions.set(scrollKey, tableRef.current.scrollTop)
    const returnTo = `/opportunities?${searchParams.toString()}`
    navigate(`/opportunities/ebuy/${encodeURIComponent(opportunity.requestId)}?returnTo=${encodeURIComponent(returnTo)}`)
  }

  const addToPipeline = (opportunity, outlook) => withAction(opportunity.requestId, async () => {
    let saved = null
    try {
      saved = await add(ebuyToPipelineRecord(opportunity, outlook))
    } catch (error) {
      toast?.error(`Could not add this eBuy opportunity: ${error.message}`)
      return
    }
    try {
      await archive.updateState(opportunity.requestId, outlook === 'Tracking' ? 'tracked' : 'added_to_pipeline', saved['Contract Number / Notice ID'])
      toast?.success(outlook === 'Tracking' ? 'Added to Tracking' : 'Added to pipeline')
    } catch (error) {
      toast?.error(`Added to the pipeline, but the eBuy archive status could not update: ${error.message}`)
    }
  })

  const changeState = (opportunity, nextState) => withAction(opportunity.requestId, async () => {
    if (nextState === 'dismissed' && opportunity.reviewState === 'flagged' && !window.confirm(`This eBuy opportunity is flagged. Dismiss "${opportunity.title}" anyway?`)) return
    try { await archive.updateState(opportunity.requestId, nextState) } catch (error) { toast?.error(error.message) }
  })

  return (
    <section className={styles.workspace} aria-label="GSA eBuy opportunities">
      <div className={styles.toolbar}>
        <div className={styles.filters}>
          <label><span>Type</span><select value={type} onChange={(event) => setType(event.target.value)}>
            <option value="all">All types</option><option value="RFI">RFI</option><option value="RFQ">RFQ</option><option value="RFP">RFP</option>
          </select></label>
          <label><span>Review state</span><select value={state} onChange={(event) => setState(event.target.value)}>
            <option value="all">All active</option><option value="new">New</option><option value="flagged">Flagged</option><option value="tracked">Tracked</option><option value="added_to_pipeline">In pipeline</option>
          </select></label>
          <label className={styles.check}><input type="checkbox" checked={includeDismissed} onChange={(event) => setIncludeDismissed(event.target.checked)} /> Show dismissed</label>
        </div>
        <div className={styles.syncSummary}>
          <span>{archive.total} archived opportunit{archive.total === 1 ? 'y' : 'ies'}</span>
          {archive.status?.lastSync?.completed_at && <span>Last synced: {formatEbuyDateTime(archive.status.lastSync.completed_at)}</span>}
          <button className="btn btn-primary" onClick={() => archive.synchronize().then((result) => toast?.success(result.alreadyRunning ? 'eBuy synchronization is already running' : 'eBuy synchronization started')).catch((error) => toast?.error(error.message))} disabled={archive.syncing}>
            {archive.syncing ? 'Synchronizing…' : 'Synchronize'}
          </button>
          <button className="btn" onClick={() => archive.refresh()} disabled={archive.loading}>Refresh</button>
        </div>
      </div>

      <EbuySyncProgress run={archive.status?.lastSync} />

      {archive.error && <div className={styles.error}><strong>eBuy archive could not load</strong><span>{archive.error.message}</span></div>}
      {archive.loading ? <div className={styles.loading}><div className="skeleton" /><div className="skeleton" /><div className="skeleton" /></div> : (
        <div ref={tableRef} className={styles.tableWrap} onScroll={(event) => listScrollPositions.set(scrollKey, event.currentTarget.scrollTop)}>
          <table className={`data-table ${styles.table}`}>
            <thead><tr><th>Opportunity</th><th>Type</th><th>Request ID</th><th>Agency</th><th>Set aside</th><th>Contract</th><th>Amendment</th><th>Posted</th><th>Closes</th><th>Actions</th></tr></thead>
            <tbody>
              {archive.opportunities.map((opportunity) => {
                const busy = actioning.has(opportunity.requestId)
                const inPipeline = pipelineIds.has(opportunity.requestId.toLowerCase()) || ['tracked', 'added_to_pipeline'].includes(opportunity.reviewState)
                return <tr key={opportunity.requestId}>
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
                    <button className={`${styles.action} ${styles.dismiss}`} onClick={() => changeState(opportunity, 'dismissed')} disabled={busy}>Dismiss</button>
                    <button className={`${styles.action} ${styles.details}`} onClick={() => openDetail(opportunity)}>Details</button>
                  </div></td>
                </tr>
              })}
              {!archive.opportunities.length && !archive.error && <tr><td colSpan="10" className={styles.empty}>No eBuy opportunities match this view.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
