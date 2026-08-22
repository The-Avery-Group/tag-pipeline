import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import Topbar from '@/components/Layout/Topbar'
import RichText from '@/components/Common/RichText'
import CopyValue from '@/components/Common/CopyValue'
import Modal from '@/components/Common/Modal'
import { DiscoveryTypeBadge } from '@/components/Opportunity/DiscoveryToolbar'
import { usePipeline } from '@/hooks/usePipeline'
import { ebuyToPipelineRecord, getEbuyOpportunity, updateEbuyOpportunityState } from '@/services/ebuyService'
import {
  formatEbuyChangedField,
  formatEbuyAttachmentMeta,
  formatEbuyCloseDuration,
  formatEbuyDateTime,
  normalizeEbuyNoticeType,
} from '@/utils/ebuyHelpers'
import styles from './EbuyOpportunityDetail.module.css'

function singleLine(value) { return String(value || '').replace(/\s+/g, ' ').trim() }

function Field({ label, children, wide = false }) {
  const copyable = typeof children === 'string' || typeof children === 'number'
  return <div className={`${styles.field} ${wide ? styles.wide : ''}`}><span>{label}</span><div>{copyable && children ? <CopyValue value={children} label={label}>{children}</CopyValue> : children || 'Not provided'}</div></div>
}

export default function EbuyOpportunityDetail({ toast }) {
  const { requestId = '' } = useParams()
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const { pipeline, add } = usePipeline()
  const [opportunity, setOpportunity] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [actioning, setActioning] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [dismissedPrompt, setDismissedPrompt] = useState(false)
  const actionRef = useRef(false)
  const inPipeline = useMemo(() => pipeline.some((item) => String(item['Contract Number / Notice ID'] || '').trim().toLowerCase() === decodeURIComponent(requestId).toLowerCase()), [pipeline, requestId])
  const returnTo = searchParams.get('returnTo') || '/opportunities?tab=New&source=ebuy'

  useEffect(() => {
    let active = true
    setHistoryOpen(false)
    setLoading(true)
    getEbuyOpportunity(decodeURIComponent(requestId)).then((result) => {
      if (active) { setOpportunity(result); setError(null) }
    }).catch((loadError) => { if (active) setError(loadError) })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [requestId])

  const act = async (callback) => {
    if (actionRef.current) return
    actionRef.current = true
    setActioning(true)
    try { await callback() } finally { actionRef.current = false; setActioning(false) }
  }

  const changeState = (reviewState) => act(async () => {
    try {
      const result = await updateEbuyOpportunityState(opportunity.requestId, reviewState)
      setOpportunity(result.opportunity)
      toast?.success(reviewState === 'flagged' ? 'Flagged for the team' : 'eBuy review state updated')
      if (reviewState === 'dismissed') setDismissedPrompt(true)
    } catch (stateError) { toast?.error(stateError.message) }
  })

  const addToPipeline = (outlook) => act(async () => {
    let saved = null
    try {
      saved = await add(ebuyToPipelineRecord(opportunity, outlook))
    } catch (addError) {
      toast?.error(`Could not add this eBuy opportunity: ${addError.message}`)
      return
    }
    try {
      const result = await updateEbuyOpportunityState(opportunity.requestId, outlook === 'Tracking' ? 'tracked' : 'added_to_pipeline', saved['Contract Number / Notice ID'])
      setOpportunity(result.opportunity)
      toast?.success(outlook === 'Tracking' ? 'Added to Tracking' : 'Added to pipeline')
    } catch (statusError) { toast?.error(`Added to the pipeline, but the eBuy archive status could not update: ${statusError.message}`) }
  })

  if (loading) return <div className="page-body"><div className="skeleton" style={{ height: 240 }} /></div>
  if (error || !opportunity) return <div className="page-body"><div className={styles.error}><strong>eBuy opportunity could not load</strong><span>{error?.message || 'The archived record was not found.'}</span><button className="btn" onClick={() => navigate(returnTo)}>Back to discovery</button></div></div>

  return <>
    <Topbar title={singleLine(opportunity.title) || opportunity.requestId} subtitle1={`GSA eBuy · ${opportunity.requestId}`} showFilter={false} showNew={false} />
    <div className={`page-body ${styles.page}`}>
      <button className={styles.back} onClick={() => navigate(returnTo)}>← Back to eBuy discovery</button>
      <section className={styles.hero}>
        <div>
          <div className={styles.badges}><DiscoveryTypeBadge type={normalizeEbuyNoticeType(opportunity)} /><span>{opportunity.lifecycleStatus}</span><span className={styles.closeDuration}>{formatEbuyCloseDuration(opportunity.closesAt)}</span>{opportunity.reviewState !== 'new' && <span>{opportunity.reviewState.replaceAll('_', ' ')}</span>}</div>
          <h1>{singleLine(opportunity.title)}</h1>
          <p>{opportunity.buyerAgency || 'Agency not provided'}{opportunity.buyerDepartment && opportunity.buyerDepartment !== opportunity.buyerAgency ? ` · ${opportunity.buyerDepartment}` : ''}</p>
        </div>
        <div className={styles.heroActions}>
          <button className={`${styles.flag} ${opportunity.reviewState === 'flagged' ? styles.flagActive : ''}`} onClick={() => changeState(opportunity.reviewState === 'flagged' ? 'new' : 'flagged')} disabled={actioning}>⚑ {opportunity.reviewState === 'flagged' ? 'Flagged' : 'Flag'}</button>
          {!inPipeline && <button className="btn btn-primary" onClick={() => addToPipeline('New')} disabled={actioning}>+ Add to pipeline</button>}
          {!inPipeline && <button className="btn" onClick={() => addToPipeline('Tracking')} disabled={actioning}>Track</button>}
          {inPipeline && <button className="btn btn-primary" onClick={() => {
            const linked = pipeline.find((item) => String(item['Contract Number / Notice ID'] || '').trim().toLowerCase() === decodeURIComponent(requestId).toLowerCase())
            if (linked) navigate(`/opportunities/${encodeURIComponent(linked['Contract Number / Notice ID'])}?row=${linked._rowIndex}`)
          }}>Open opportunity</button>}
          {opportunity.reviewState !== 'dismissed' && <button className={styles.dismiss} onClick={() => changeState('dismissed')} disabled={actioning}>Dismiss</button>}
        </div>
      </section>


      <section className={styles.card}>
        <header><div><span className={styles.eyebrow}>Overview</span><h2>Opportunity summary</h2></div></header>
        <div className={styles.grid}>
          <Field label="Request ID">{opportunity.requestId}</Field><Field label="Reference number">{opportunity.referenceNumber}</Field>
          <Field label="Posted">{formatEbuyDateTime(opportunity.postedAt)}</Field><Field label="Closes">{formatEbuyDateTime(opportunity.closesAt)}</Field>
          <Field label="Department">{opportunity.buyerDepartment}</Field><Field label="Agency">{opportunity.buyerAgency}</Field>
          <Field label="Set aside">{opportunity.setAsideType}</Field><Field label="Follow-on">{opportunity.isFollowOn ? 'Yes' : 'No'}</Field>
          <Field label="Amendments">{opportunity.amendments?.length || 0}</Field>
          <Field label="Description" wide><RichText value={opportunity.description} /></Field>
        </div>
      </section>

      <section className={styles.card}>
        <header><div><span className={styles.eyebrow}>Contract</span><h2>Acquisition details</h2></div></header>
        <div className={styles.grid}>
          <Field label="Contract type">{opportunity.contractType}</Field><Field label="Award method">{opportunity.awardMethod}</Field>
          <Field label="Vehicle">{opportunity.vehicleSources?.join(', ')}</Field><Field label="SINs">{opportunity.vehicleSins?.join(', ')}</Field>
          <Field label="Vehicle and SIN">{opportunity.vehiclePairs?.join(', ')}</Field><Field label="Performance states">{opportunity.performanceStates?.join(', ')}</Field>
          <Field label="Place of performance" wide>{opportunity.placeOfPerformanceRaw}</Field>
        </div>
      </section>

      <section className={styles.card}>
        <header><div><span className={styles.eyebrow}>Buyer</span><h2>Contact</h2></div></header>
        <div className={styles.grid}><Field label="Name">{opportunity.buyerName}</Field><Field label="Phone">{opportunity.buyerPhone}</Field><Field label="Email" wide>{opportunity.buyerEmail ? <CopyValue value={opportunity.buyerEmail} label="email address"><a href={`mailto:${opportunity.buyerEmail}`}>{opportunity.buyerEmail}</a></CopyValue> : null}</Field></div>
      </section>

      <section className={styles.card}>
        <header><div><span className={styles.eyebrow}>Archive</span><h2>Record history</h2></div><button
          type="button"
          className={styles.sectionToggle}
          onClick={() => setHistoryOpen((value) => !value)}
          aria-expanded={historyOpen}
          title={historyOpen ? 'Collapse record history' : 'Expand record history'}
        ><span className={styles.count}>{opportunity.versions?.length || 0}</span><span className={`${styles.sectionChevron} ${historyOpen ? styles.sectionChevronOpen : ''}`} aria-hidden="true">⌄</span></button></header>
        {historyOpen && <div className={styles.history}>{opportunity.versions?.map((version, index) => {
          const fields = (version.changedFields || []).map(formatEbuyChangedField).filter(Boolean)
          return <article className={styles.historyItem} key={`${version.capturedAt}-${index}`}>
            <div className={styles.historyMarker} aria-hidden="true" />
            <div className={styles.historyContent}>
              <div className={styles.historyHeading}><strong>{version.initial ? 'Initial archive snapshot' : 'Opportunity record changed'}</strong><time>{formatEbuyDateTime(version.capturedAt)}</time></div>
              <span className={styles.historySummary}>{version.initial ? 'Material-field baseline saved' : `${fields.length} material field${fields.length === 1 ? '' : 's'} changed in GSA eBuy`}</span>
              {!version.initial && fields.length > 0 && <div className={styles.changeChips}>{fields.map((field) => <span key={field}>{field}</span>)}</div>}
            </div>
          </article>
        })}{!opportunity.versions?.length && <p className={styles.empty}>No archived record changes yet.</p>}</div>}
      </section>

      <section className={styles.card}>
        <header><div><span className={styles.eyebrow}>Updates</span><h2>Amendments</h2></div><span className={styles.count}>{opportunity.amendments?.length || 0}</span></header>
        <div className={styles.list}>{opportunity.amendments?.map((amendment) => <article className={styles.amendmentItem} key={amendment.id}><div className={styles.amendmentHeading}><strong>{amendment.label || 'Amendment'}</strong><time>{formatEbuyDateTime(amendment.posted_at)}</time></div><p>{amendment.description || 'No description provided.'}</p></article>)}{!opportunity.amendments?.length && <p className={styles.empty}>No amendments were included in this archive.</p>}</div>
      </section>

      <section className={styles.card}>
        <header><div><span className={styles.eyebrow}>Files</span><h2>Attachments</h2></div><span className={styles.count}>{opportunity.attachments?.length || 0}</span></header>
        <div className={styles.list}>{opportunity.attachments?.map((attachment) => {
          const failed = attachment.archiveStatus === 'error'
          return <article key={attachment.id} className={styles.file}>
            <div>
              <strong>{attachment.fileName}</strong>
              <span>{formatEbuyAttachmentMeta(attachment)}</span>
              {failed && <span className={styles.fileError}>{attachment.errorMessage || 'The file could not be archived during the last synchronization.'}</span>}
            </div>
            {attachment.sharepointWebUrl
              ? <a className="btn" href={attachment.sharepointWebUrl} target="_blank" rel="noreferrer">Open archived file</a>
              : <span className={styles.pending}>{failed ? 'Retries on next sync' : 'Awaiting archive'}</span>}
          </article>
        })}{!opportunity.attachments?.length && <p className={styles.empty}>No attachments were included in this archive.</p>}</div>
      </section>
    </div>
    {dismissedPrompt && <Modal title="Opportunity dismissed" onClose={() => setDismissedPrompt(false)} footer={<>
      <button className="btn" onClick={() => setDismissedPrompt(false)}>Stay here</button>
      <button className="btn btn-primary" autoFocus onClick={() => navigate(returnTo)}>Back to opportunities</button>
    </>}><p className="text-sm">This opportunity is hidden from the active eBuy list.</p></Modal>}
  </>
}
