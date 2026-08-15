import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import Topbar from '@/components/Layout/Topbar'
import RichText from '@/components/Common/RichText'
import { usePipeline } from '@/hooks/usePipeline'
import { useSAMOpportunities } from '@/hooks/useSAMOpportunities'
import { formatDateTime } from '@/utils/kpiHelpers'
import { cleanSAMOpportunityTitle, isSAMOpportunityFlagged, normalizeSAMNoticeType } from '@/utils/samOpportunityHelpers'
import {
  getSAMOpportunityArchiveStatus,
  getSAMOpportunityDetail,
  startSAMOpportunityArchive,
  updateSAMOpportunityArchiveReview,
} from '@/services/samOpportunityService'
import styles from './SAMOpportunityDetail.module.css'

function clean(value) { return String(value || '').trim() }
function same(left, right) { return clean(left).toLowerCase() === clean(right).toLowerCase() }

function Field({ label, children, wide = false }) {
  if (children === null || children === undefined || children === '') return null
  return <div className={`${styles.field} ${wide ? styles.wide : ''}`}><span>{label}</span><div>{children}</div></div>
}

function Card({ eyebrow, title, count, children }) {
  return <section className={styles.card}>
    <header><div><span className={styles.eyebrow}>{eyebrow}</span><h2>{title}</h2></div>{count !== undefined && <span className={styles.count}>{count}</span>}</header>
    {children}
  </section>
}

function fallbackDetail(row, routeNoticeId) {
  if (!row) return null
  return {
    noticeId: clean(row['Notice ID'] || routeNoticeId),
    solicitationNumber: clean(row['Solicitation Number']),
    title: cleanSAMOpportunityTitle(row.Title),
    status: 'Active', active: true,
    noticeType: normalizeSAMNoticeType(row['Notice Type']),
    responseDeadline: row['Response Date'], postedDate: row['Posted Date'],
    organization: {
      department: row.Department || '', subTier: row.Agency || '', office: row.Office || '',
      majorCommand: '', subCommand1: '', subCommand2: '', subCommand3: '',
    },
    setAside: row['Set-Aside Type'] || '', naicsCode: row['NAICS Code'] || '',
    contacts: clean(row['Point of Contact']).split(/\r?\n/).filter(Boolean).map((entry) => {
      const [name = '', email = '', phone = ''] = entry.split('|').map(clean)
      return { name, email, phone, type: '' }
    }),
    description: '', links: [], attachments: [], samUrl: row['SAM.gov URL'] || '', archive: null,
  }
}

function mergeArchive(detail, archive) {
  if (!detail || !archive) return detail
  const files = new Map((archive.files || []).map((file) => [file.sourceUrl, file]))
  return {
    ...detail,
    attachments: (detail.attachments || []).map((attachment) => ({ ...attachment, ...(files.get(attachment.sourceUrl) || {}) })),
    archive: {
      opportunityKey: archive.opportunityKey,
      archiveStatus: archive.archiveStatus,
      progressPhase: archive.progressPhase,
      attachmentTotal: archive.attachmentTotal,
      archivedCount: archive.archivedCount,
      failedCount: archive.failedCount,
      errorMessage: archive.errorMessage,
      webUrl: archive.webUrl,
      updatedAt: archive.updatedAt,
    },
  }
}

export default function SAMOpportunityDetail({ toast }) {
  const { noticeId: routeNoticeId = '' } = useParams()
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const { pipeline } = usePipeline()
  const {
    opportunities, loading: rowsLoading, addToPipeline, dismiss, undismiss, updateFlag,
  } = useSAMOpportunities()
  const [detail, setDetail] = useState(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(null)
  const [actioning, setActioning] = useState(false)
  const [archiving, setArchiving] = useState(false)
  const [descriptionExpanded, setDescriptionExpanded] = useState(false)
  const actionRef = useRef(false)
  const archiveStartedRef = useRef(false)
  const decodedNoticeId = decodeURIComponent(routeNoticeId)
  const rowIndex = Number(searchParams.get('row'))
  const returnCandidate = searchParams.get('returnTo') || '/opportunities?tab=New&source=sam'
  const returnTo = returnCandidate.startsWith('/opportunities') ? returnCandidate : '/opportunities?tab=New&source=sam'

  const row = useMemo(() => opportunities.find((item) => (
    (Number.isInteger(rowIndex) && item._rowIndex === rowIndex) ||
    same(item['Notice ID'], decodedNoticeId) || same(item['Solicitation Number'], decodedNoticeId)
  )) || null, [decodedNoticeId, opportunities, rowIndex])

  const identifier = useMemo(() => ({
    noticeId: row?.['Notice ID'] || decodedNoticeId,
    solicitationNumber: row?.['Solicitation Number'] || '',
  }), [decodedNoticeId, row])
  const opportunityKey = clean(detail?.solicitationNumber || detail?.noticeId || identifier.solicitationNumber || identifier.noticeId).toLowerCase()
  const linkedPipeline = useMemo(() => pipeline.find((item) => (
    same(item['Contract Number / Notice ID'], detail?.solicitationNumber || row?.['Solicitation Number']) ||
    same(item['Contract Number / Notice ID'], detail?.noticeId || row?.['Notice ID']) ||
    same(item['Solicitation Number'], detail?.solicitationNumber || row?.['Solicitation Number'])
  )) || null, [detail, pipeline, row])

  const loadDetail = useCallback(async ({ quiet = false } = {}) => {
    if (!quiet) setLoading(true)
    try {
      const result = await getSAMOpportunityDetail(identifier)
      setDetail(result.opportunity)
      setLoadError(null)
      return result.opportunity
    } catch (error) {
      setLoadError(error)
      setDetail((current) => current || fallbackDetail(row, decodedNoticeId))
      return null
    } finally {
      if (!quiet) setLoading(false)
    }
  }, [decodedNoticeId, identifier, row])

  useEffect(() => {
    archiveStartedRef.current = false
    setDetail(null)
    setLoadError(null)
    setDescriptionExpanded(false)
  }, [decodedNoticeId])

  useEffect(() => {
    if (rowsLoading && !row) return
    loadDetail()
  }, [loadDetail, row, rowsLoading])

  const startArchive = useCallback(async ({ force = false } = {}) => {
    if (!identifier.noticeId && !identifier.solicitationNumber) return
    setArchiving(true)
    try {
      await startSAMOpportunityArchive(identifier, { force })
      await loadDetail({ quiet: true })
    } catch (error) {
      toast?.error(`SAM.gov archive could not start: ${error.message}`)
    } finally {
      setArchiving(false)
    }
  }, [identifier, loadDetail, toast])

  useEffect(() => {
    if (!detail?.attachments?.length || archiveStartedRef.current) return
    if (detail.archive && !['new'].includes(detail.archive.archiveStatus)) return
    archiveStartedRef.current = true
    startArchive()
  }, [detail, startArchive])

  useEffect(() => {
    if (!opportunityKey || detail?.archive?.archiveStatus !== 'running') return undefined
    let active = true
    const poll = async () => {
      try {
        const result = await getSAMOpportunityArchiveStatus(opportunityKey)
        if (active && result.archive) setDetail((current) => mergeArchive(current, result.archive))
      } catch { /* the next poll can recover */ }
    }
    const timer = setInterval(poll, 3000)
    poll()
    return () => { active = false; clearInterval(timer) }
  }, [detail?.archive?.archiveStatus, opportunityKey])

  const act = async (callback) => {
    if (actionRef.current || !row) return
    actionRef.current = true
    setActioning(true)
    try { await callback() } finally { actionRef.current = false; setActioning(false) }
  }

  const add = (outlook) => act(async () => {
    try {
      await addToPipeline(row, outlook)
      toast?.success(outlook === 'Tracking' ? 'Added to Tracking' : 'Added to pipeline')
    } catch (error) { toast?.error(`Could not add this opportunity: ${error.message}`) }
  })

  const changeDismissed = () => act(async () => {
    const dismissed = row.Status === 'dismissed'
    if (!dismissed && isSAMOpportunityFlagged(row.Flagged) && !window.confirm(`This opportunity is flagged for the team. Dismiss “${detail?.title || row.Title}” anyway?`)) return
    try {
      if (dismissed) await undismiss(row._rowIndex, linkedPipeline ? 'added_to_pipeline' : 'new')
      else await dismiss(row._rowIndex)
      updateSAMOpportunityArchiveReview(identifier, dismissed ? 'new' : 'dismissed').catch(() => {})
      toast?.success(dismissed ? 'Opportunity restored' : 'Opportunity dismissed')
    } catch (error) { toast?.error(error.message) }
  })

  const toggleFlag = () => act(async () => {
    try { await updateFlag(row._rowIndex, !isSAMOpportunityFlagged(row.Flagged)) }
    catch (error) { toast?.error(`Could not update the team flag: ${error.message}`) }
  })

  if (loading && !detail) return <div className="page-body"><div className="skeleton" style={{ height: 260 }} /></div>
  if (!detail) return <div className="page-body"><div className={styles.error}><strong>SAM.gov opportunity could not load</strong><span>{loadError?.message || 'The discovery record was not found.'}</span><button className="btn" onClick={() => navigate(returnTo)}>Back to discovery</button></div></div>

  const organization = detail.organization || {}
  const filesReady = (detail.attachments || []).filter((file) => ['archived', 'moved'].includes(file.archiveStatus)).length
  const archiveRunning = detail.archive?.archiveStatus === 'running'
  const descriptionIsLong = clean(detail.description).length > 900 || clean(detail.description).split(/\r?\n/).length > 10

  return <>
    <Topbar title={detail.title || detail.noticeId} subtitle1={`SAM.gov · ${detail.noticeId || detail.solicitationNumber}`} showFilter={false} showNew={false} />
    <div className={`page-body ${styles.page}`}>
      <button className={styles.back} onClick={() => navigate(returnTo)}>← Back to SAM.gov discovery</button>
      {loadError && <div className={styles.warning}>Live SAM.gov details could not refresh. Showing the saved discovery information. <button onClick={() => loadDetail()}>Try again</button></div>}

      <section className={styles.hero}>
        <div className={styles.heroText}>
          <div className={styles.badges}>
            {detail.noticeType && <span>{detail.noticeType}</span>}
            <span className={detail.active ? styles.active : styles.inactive}>{detail.status}</span>
            {row?.Status && row.Status !== 'new' && <span>{row.Status.replaceAll('_', ' ')}</span>}
          </div>
          <h1>{detail.title}</h1>
          <p>{organization.subTier || organization.department || 'Organization not provided'} · {detail.noticeId || detail.solicitationNumber}</p>
        </div>
        <div className={styles.heroActions}>
          {row && <button className={`${styles.flag} ${isSAMOpportunityFlagged(row.Flagged) ? styles.flagActive : ''}`} onClick={toggleFlag} disabled={actioning}>⚑ {isSAMOpportunityFlagged(row.Flagged) ? 'Flagged' : 'Flag'}</button>}
          {!linkedPipeline && row && row.Status !== 'dismissed' && <button className="btn btn-primary" onClick={() => add('New')} disabled={actioning}>+ Add to pipeline</button>}
          {!linkedPipeline && row && row.Status !== 'dismissed' && <button className="btn" onClick={() => add('Tracking')} disabled={actioning}>Track</button>}
          {row && <button className={row.Status === 'dismissed' ? 'btn' : styles.dismiss} onClick={changeDismissed} disabled={actioning}>{row.Status === 'dismissed' ? 'Restore' : 'Dismiss'}</button>}
          {linkedPipeline && <button className="btn btn-primary" onClick={() => navigate(`/opportunities/${encodeURIComponent(linkedPipeline['Contract Number / Notice ID'])}?row=${linkedPipeline._rowIndex}`)}>View in pipeline</button>}
          {detail.samUrl && <a className="btn" href={detail.samUrl} target="_blank" rel="noreferrer">Open on SAM.gov</a>}
        </div>
      </section>

      <Card eyebrow="Solicitation" title="Solicitation details">
        <div className={styles.grid}>
          <Field label="Notice ID">{detail.noticeId}</Field>
          <Field label="Solicitation number">{detail.solicitationNumber}</Field>
          <Field label="Related notice">{detail.relatedNotice}</Field>
          <Field label="Opportunity type">{detail.opportunityType || detail.noticeType}</Field>
          <Field label="Contract line item number">{detail.contractLineItemNumber}</Field>
          <Field label="Offers due">{formatDateTime(detail.responseDeadline)}</Field>
          <Field label="Published">{formatDateTime(detail.postedDate)}</Field>
          <Field label="Last modified">{formatDateTime(detail.modifiedDate)}</Field>
          {!detail.active && <Field label="Inactive date">{formatDateTime(detail.archiveDate)}</Field>}
          {!detail.active && <Field label="Inactive policy">{detail.archiveType}</Field>}
        </div>
      </Card>

      <Card eyebrow="Organization" title="Contracting organization">
        <div className={styles.grid}>
          <Field label="Department or independent agency">{organization.department}</Field>
          <Field label="Sub-tier or agency">{organization.subTier}</Field>
          <Field label="Major command">{organization.majorCommand}</Field>
          <Field label="Sub-command 1">{organization.subCommand1}</Field>
          <Field label="Sub-command 2">{organization.subCommand2}</Field>
          <Field label="Sub-command 3">{organization.subCommand3}</Field>
          <Field label="Office" wide>{organization.office}</Field>
        </div>
      </Card>

      <Card eyebrow="Classification" title="Classification">
        <div className={styles.grid}>
          <Field label="Set-aside">{detail.setAside}</Field>
          <Field label="Product service code">{detail.productServiceCode}</Field>
          <Field label="NAICS">{detail.naicsCode}</Field>
          <Field label="Initiative">{detail.initiative}</Field>
          <Field label="Place of performance" wide>{detail.placeOfPerformance}</Field>
        </div>
      </Card>

      <Card eyebrow="Requirement" title="Description">
        <div className={`${styles.description} ${descriptionIsLong && !descriptionExpanded ? styles.descriptionCollapsed : ''}`}>
          {detail.description ? <RichText value={detail.description} /> : <span className={styles.empty}>No description was provided.</span>}
        </div>
        {descriptionIsLong && <button
          type="button"
          className={styles.descriptionToggle}
          aria-expanded={descriptionExpanded}
          onClick={() => setDescriptionExpanded((current) => !current)}
        >
          {descriptionExpanded ? 'See less' : 'See more'}
        </button>}
      </Card>

      <Card eyebrow="Contacts" title="Contact information" count={(detail.contacts || []).length}>
        <div className={styles.contactList}>
          {(detail.contacts || []).map((contact, index) => <article key={`${contact.email || contact.name}-${index}`}>
            <div><strong>{contact.name || 'Unnamed contact'}</strong>{contact.type && <span>{contact.type}</span>}{contact.title && <span>{contact.title}</span>}</div>
            <div className={styles.contactMethods}>{contact.email && <a href={`mailto:${contact.email}`}>{contact.email}</a>}{contact.phone && <a href={`tel:${contact.phone}`}>{contact.phone}</a>}{contact.fax && <span>Fax {contact.fax}</span>}</div>
          </article>)}
          {!detail.contacts?.length && <p className={styles.empty}>No points of contact were provided.</p>}
        </div>
        {detail.contractingOfficeAddress && <div className={styles.officeAddress}><span>Contracting office address</span><RichText value={detail.contractingOfficeAddress} /></div>}
      </Card>

      {(detail.links?.length > 0 || detail.attachments?.length > 0) && <Card eyebrow="Resources" title="Attachments and links" count={(detail.links?.length || 0) + (detail.attachments?.length || 0)}>
        {detail.links?.length > 0 && <div className={styles.resourceGroup}><h3>Links</h3><div className={styles.resourceList}>{detail.links.map((link) => <article key={link.url}><div><strong>{link.label}</strong><span>{link.url}</span></div><a className="btn" href={link.url} target="_blank" rel="noreferrer">Open link</a></article>)}</div></div>}
        {detail.attachments?.length > 0 && <div className={styles.resourceGroup}>
          <div className={styles.resourceHeading}><div><h3>Attachments</h3><span>{filesReady} of {detail.attachments.length} preserved in SharePoint</span></div>{detail.archive?.webUrl && <a href={detail.archive.webUrl} target="_blank" rel="noreferrer">Open archive folder</a>}</div>
          {(archiveRunning || archiving) && <div className={styles.archiveProgress}><div><span>{detail.archive?.progressPhase || 'Preparing SAM.gov archive'}</span><strong>{filesReady}/{detail.attachments.length}</strong></div><div><span style={{ width: `${Math.round((filesReady / Math.max(1, detail.attachments.length)) * 100)}%` }} /></div></div>}
          {['partial', 'error'].includes(detail.archive?.archiveStatus) && <div className={styles.archiveIssue}><span>{detail.archive.errorMessage || 'Some files need attention.'}</span><button className="btn" onClick={() => startArchive({ force: true })} disabled={archiving}>Retry archive</button></div>}
          <div className={styles.resourceList}>{detail.attachments.map((file, index) => <article key={file.sourceUrl || index}><div><strong>{file.fileName}</strong><span>{file.byteSize ? `${Math.ceil(file.byteSize / 1024)} KB · ` : ''}{file.archiveStatus === 'archived' ? 'Preserved in SAM.gov Archive' : file.archiveStatus === 'moved' ? 'Moved into opportunity workspace' : file.archiveStatus === 'failed' ? 'Archive failed' : 'Awaiting archive'}</span>{file.errorMessage && <span className={styles.fileError}>{file.errorMessage}</span>}</div>{file.webUrl ? <a className="btn" href={file.webUrl} target="_blank" rel="noreferrer">Open file</a> : <span className={styles.pending}>Processing</span>}</article>)}</div>
        </div>}
      </Card>}

      {!detail.links?.length && !detail.attachments?.length && <Card eyebrow="Resources" title="Attachments and links"><p className={styles.empty}>No attachments or external links were included with this notice.</p></Card>}
    </div>
  </>
}
