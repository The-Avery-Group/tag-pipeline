import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import Topbar from '@/components/Layout/Topbar'
import RichText from '@/components/Common/RichText'
import CopyValue from '@/components/Common/CopyValue'
import Modal from '@/components/Common/Modal'
import DocumentAnalysisPanel from '@/components/Opportunity/DocumentAnalysisPanel'
import { usePipeline } from '@/hooks/usePipeline'
import { useSAMOpportunities } from '@/hooks/useSAMOpportunities'
import { formatDateTime } from '@/utils/kpiHelpers'
import { buildSAMOpportunityPatch, cleanSAMOpportunityTitle, isSAMOpportunityFlagged, normalizeSAMNoticeType } from '@/utils/samOpportunityHelpers'
import { retryOpportunityWorkspace } from '@/services/opportunityWorkspaceService'
import { startAdaptivePolling } from '@/services/workerClient'
import {
  getSAMOpportunityArchiveStatus,
  getSAMOpportunityDocumentAnalysis,
  getSAMOpportunityDetail,
  analyzeSAMOpportunityDocuments,
  reviewSAMOpportunityDocumentFinding,
  startSAMOpportunityArchive,
  updateSAMOpportunityArchiveReview,
} from '@/services/samOpportunityService'
import styles from './SAMOpportunityDetail.module.css'

function clean(value) { return String(value || '').trim() }
function same(left, right) { return clean(left).toLowerCase() === clean(right).toLowerCase() }

const PIPELINE_COLUMNS = {
  noticeType: 'Notice Type', title: 'Project Title / Description*', solNum: 'Solicitation Number',
  setAside: 'Set- Aside*', department: 'Department*', agency: 'Agency*', office: 'Office*',
  naics: 'NAICS Code*', submDate: 'Submission Date (Response Date)*', otherLinks: 'Other Links*',
}

function pipelineSnapshot(detail) {
  return {
    title: detail.title,
    type: detail.noticeType,
    baseType: detail.baseType,
    solicitationNumber: detail.solicitationNumber,
    setAside: detail.setAside,
    organization: [detail.organization?.department, detail.organization?.subTier, detail.organization?.office].filter(Boolean).join('.'),
    naics: detail.naicsCode,
    responseDate: detail.responseDeadline,
    uiLink: detail.samUrl,
  }
}
function linkHost(value) {
  try { return new URL(value).hostname.replace(/^www\./, '') } catch { return value }
}
function Field({ label, children, wide = false }) {
  if (children === null || children === undefined || children === '') return null
  const copyable = typeof children === 'string' || typeof children === 'number'
  return <div className={`${styles.field} ${wide ? styles.wide : ''}`}><span>{label}</span><div>{copyable ? <CopyValue value={children} label={label}>{children}</CopyValue> : children}</div></div>
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
  const { pipeline, update: updatePipeline } = usePipeline()
  const {
    opportunities, loading: rowsLoading, addToPipeline, dismiss, undismiss, updateFlag,
  } = useSAMOpportunities()
  const [detail, setDetail] = useState(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(null)
  const [actioning, setActioning] = useState(false)
  const [archiving, setArchiving] = useState(false)
  const [descriptionExpanded, setDescriptionExpanded] = useState(false)
  const [retryingDetail, setRetryingDetail] = useState(false)
  const [dismissedPrompt, setDismissedPrompt] = useState(false)
  const actionRef = useRef(false)
  const archiveStartedRef = useRef(false)
  const decodedNoticeId = decodeURIComponent(routeNoticeId)
  const rowParam = searchParams.get('row')
  const rowIndex = rowParam !== null && /^\d+$/.test(rowParam) ? Number(rowParam) : null
  const returnCandidate = searchParams.get('returnTo') || '/opportunities?tab=New&source=sam'
  const returnTo = returnCandidate.startsWith('/opportunities') ? returnCandidate : '/opportunities?tab=New&source=sam'

  const row = useMemo(() => opportunities.find((item) => (
    (rowIndex !== null && Number(item._rowIndex) === rowIndex) ||
    same(item['Notice ID'], decodedNoticeId) || same(item['Solicitation Number'], decodedNoticeId)
  )) || null, [decodedNoticeId, opportunities, rowIndex])

  const identifier = useMemo(() => ({
    noticeId: row?.['Notice ID'] || decodedNoticeId,
    solicitationNumber: row?.['Solicitation Number'] || '',
  }), [decodedNoticeId, row])
  const opportunityKey = clean(detail?.solicitationNumber || detail?.noticeId || identifier.solicitationNumber || identifier.noticeId).toLowerCase()
  const loadDocumentAnalysis = useCallback(() => getSAMOpportunityDocumentAnalysis(opportunityKey), [opportunityKey])
  const runDocumentAnalysis = useCallback(() => analyzeSAMOpportunityDocuments({ ...identifier, noticeType: detail?.noticeType || '' }), [detail?.noticeType, identifier])
  const linkedPipeline = useMemo(() => pipeline.find((item) => (
    same(item['Contract Number / Notice ID'], detail?.solicitationNumber || row?.['Solicitation Number']) ||
    same(item['Contract Number / Notice ID'], detail?.noticeId || row?.['Notice ID']) ||
    same(item['Solicitation Number'], detail?.solicitationNumber || row?.['Solicitation Number'])
  )) || null, [detail, pipeline, row])

  const loadDetail = useCallback(async ({ quiet = false, refresh = false } = {}) => {
    if (!quiet) setLoading(true)
    try {
      const result = await getSAMOpportunityDetail(
        { ...identifier, postedDate: row?.['Posted Date'] || row?.PostedDate || '' },
        { refresh },
      )
      setDetail(result.opportunity)
      setLoadError(result.warning ? new Error(result.warning) : null)
      return result.warning ? null : result.opportunity
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
      const result = await startSAMOpportunityArchive(identifier, { force })
      if (result.archive) setDetail((current) => mergeArchive(current, result.archive))
    } catch (error) {
      toast?.error(`SAM.gov archive could not start: ${error.message}`)
    } finally {
      setArchiving(false)
    }
  }, [identifier, loadDetail, toast])

  const retryLiveOpportunity = useCallback(async () => {
    if (retryingDetail) return
    setRetryingDetail(true)
    try {
      const refreshed = await loadDetail({ refresh: true })
      if (!refreshed) return

      const pipelineOpportunity = linkedPipeline || pipeline.find((item) => (
        same(item['Contract Number / Notice ID'], refreshed.solicitationNumber) ||
        same(item['Contract Number / Notice ID'], refreshed.noticeId) ||
        same(item['Solicitation Number'], refreshed.solicitationNumber)
      ))

      if (pipelineOpportunity) {
        const { patch } = buildSAMOpportunityPatch(pipelineOpportunity, pipelineSnapshot(refreshed), PIPELINE_COLUMNS)
        const refreshedPipelineOpportunity = {
          ...pipelineOpportunity,
          ...patch,
          _workspaceNoticeId: refreshed.noticeId || identifier.noticeId,
        }
        if (Object.keys(patch).length) {
          await updatePipeline(pipelineOpportunity._rowIndex, patch, pipelineOpportunity)
        }
        setArchiving(true)
        archiveStartedRef.current = true
        await retryOpportunityWorkspace(
          pipelineOpportunity['Contract Number / Notice ID'],
          refreshedPipelineOpportunity,
        )
      } else if (row) {
        const saved = await addToPipeline({
          ...row,
          'Notice ID': refreshed.noticeId || row['Notice ID'],
          'Solicitation Number': refreshed.solicitationNumber || row['Solicitation Number'],
          Title: refreshed.title || row.Title,
          'Notice Type': refreshed.noticeType || row['Notice Type'],
          'Set-Aside Type': refreshed.setAside || row['Set-Aside Type'],
          Department: refreshed.organization?.department || row.Department,
          Agency: refreshed.organization?.subTier || row.Agency,
          Office: refreshed.organization?.office || row.Office,
          'NAICS Code': refreshed.naicsCode || row['NAICS Code'],
          'Response Date': refreshed.responseDeadline || row['Response Date'],
          'SAM.gov URL': refreshed.samUrl || row['SAM.gov URL'],
        }, row.Status === 'tracked' ? 'Tracking' : 'New')
        if (saved?._alreadyExisted) {
          await retryOpportunityWorkspace(saved['Contract Number / Notice ID'], {
            ...saved,
            _workspaceNoticeId: refreshed.noticeId || identifier.noticeId,
          })
        }
      } else if (refreshed.attachments?.length) {
        setArchiving(true)
        archiveStartedRef.current = true
        await startSAMOpportunityArchive({
          noticeId: refreshed.noticeId || identifier.noticeId,
          solicitationNumber: refreshed.solicitationNumber || identifier.solicitationNumber,
        }, { force: true })
      }
      await loadDetail({ quiet: true })
      toast?.success(pipelineOpportunity || row
        ? 'Pipeline opportunity reloaded; attachment refresh started'
        : 'SAM.gov opportunity and attachments are refreshing')
    } catch (error) {
      toast?.error(`SAM.gov attachments could not refresh: ${error.message}`)
    } finally {
      setArchiving(false)
      setRetryingDetail(false)
    }
  }, [addToPipeline, identifier, linkedPipeline, loadDetail, pipeline, retryingDetail, row, toast, updatePipeline])

  useEffect(() => {
    if (!detail?.attachments?.length || archiveStartedRef.current) return
    if (detail.archive && !['new'].includes(detail.archive.archiveStatus)) return
    archiveStartedRef.current = true
    startArchive()
  }, [detail, startArchive])

  useEffect(() => {
    if (!opportunityKey || detail?.archive?.archiveStatus !== 'running') return undefined
    let active = true
    const stop = startAdaptivePolling({
      key: `sam-archive:${opportunityKey}`,
      poll: () => getSAMOpportunityArchiveStatus(opportunityKey),
      onResult: (result) => {
        if (active && result.archive) setDetail((current) => mergeArchive(current, result.archive))
      },
      shouldContinue: (result) => result?.archive?.archiveStatus === 'running',
    })
    return () => { active = false; stop() }
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
      updateSAMOpportunityArchiveReview({
        ...identifier,
        responseDate: detail?.responseDeadline || row?.['Response Date'],
      }, dismissed ? 'new' : 'dismissed').catch(() => {})
      toast?.success(dismissed ? 'Opportunity restored' : 'Opportunity dismissed')
      if (!dismissed) setDismissedPrompt(true)
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
      {loadError && <div className={styles.warning}><span><strong>Live SAM.gov details could not refresh.</strong> {detail ? 'Showing the last saved opportunity information.' : 'No saved detail is available.'}</span><button disabled={retryingDetail} onClick={retryLiveOpportunity}>{retryingDetail ? 'Reloading opportunity and attachments…' : 'Try again'}</button></div>}

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

      {opportunityKey && <DocumentAnalysisPanel
        pollKey={opportunityKey}
        load={loadDocumentAnalysis}
        run={runDocumentAnalysis}
        review={(findingReview) => reviewSAMOpportunityDocumentFinding(opportunityKey, findingReview)}
        disabled={row?.Status === 'dismissed'}
        toast={toast}
      />}

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
          <Field label="Set-aside type">{detail.setAside || 'Not provided by SAM.gov'}</Field>
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
            <div className={styles.contactMethods}>{contact.email && <CopyValue value={contact.email} label="email address"><a href={`mailto:${contact.email}`}>{contact.email}</a></CopyValue>}{contact.phone && <CopyValue value={contact.phone} label="phone number"><a href={`tel:${contact.phone}`}>{contact.phone}</a></CopyValue>}{contact.fax && <CopyValue value={contact.fax} label="fax number"><span>Fax {contact.fax}</span></CopyValue>}</div>
          </article>)}
          {!detail.contacts?.length && <p className={styles.empty}>No points of contact were provided.</p>}
        </div>
        {detail.contractingOfficeAddress && <div className={styles.officeAddress}><span>Contracting office address</span><RichText value={detail.contractingOfficeAddress} /></div>}
      </Card>

      {(detail.links?.length > 0 || detail.attachments?.length > 0) && <Card eyebrow="Resources" title="Attachments and links" count={(detail.links?.length || 0) + (detail.attachments?.length || 0)}>
        {detail.attachments?.length > 0 && <div className={styles.resourceGroup}>
          <div className={styles.resourceHeading}><div><h3>Attachments</h3><span>{filesReady} of {detail.attachments.length} preserved in SharePoint</span></div>{detail.archive?.webUrl && <a href={detail.archive.webUrl} target="_blank" rel="noreferrer">Open archive folder</a>}</div>
          {(archiveRunning || archiving) && <div className={styles.archiveProgress}><div><span>{detail.archive?.progressPhase || 'Preparing SAM.gov archive'}</span><strong>{filesReady}/{detail.attachments.length}</strong></div><div><span style={{ width: `${Math.round((filesReady / Math.max(1, detail.attachments.length)) * 100)}%` }} /></div></div>}
          {['partial', 'error'].includes(detail.archive?.archiveStatus) && <div className={styles.archiveIssue}><span>{detail.archive.errorMessage || 'Some files need attention.'}</span><button className="btn" onClick={() => startArchive({ force: true })} disabled={archiving}>Retry archive</button></div>}
          <div className={styles.resourceList}>{detail.attachments.map((file, index) => {
            const fileUrl = file.webUrl || file.sourceUrl
            return <article key={file.sourceUrl || index}><div><strong><a href={fileUrl} target="_blank" rel="noreferrer">{file.fileName}</a></strong><span>{file.byteSize ? `${Math.ceil(file.byteSize / 1024)} KB · ` : ''}{file.archiveStatus === 'archived' ? 'Preserved in SAM.gov Archive' : file.archiveStatus === 'moved' ? 'Moved into opportunity workspace' : file.archiveStatus === 'failed' ? 'Archive failed' : 'Awaiting archive'}</span>{file.errorMessage && <span className={styles.fileError}>{file.errorMessage}</span>}</div><a className="btn" href={fileUrl} target="_blank" rel="noreferrer">Open File</a></article>
          })}</div>
        </div>}
        {detail.links?.length > 0 && <div className={styles.resourceGroup}><h3>External links</h3><div className={styles.resourceList}>{detail.links.map((link) => <article key={link.url}><div><strong><a href={link.url} target="_blank" rel="noreferrer">{link.label}</a></strong><span>{linkHost(link.url)}</span><CopyValue value={link.url} label="link" /></div><a className="btn" href={link.url} target="_blank" rel="noreferrer">Open Link</a></article>)}</div></div>}
      </Card>}

      {!detail.links?.length && !detail.attachments?.length && <Card eyebrow="Resources" title="Attachments and links"><p className={styles.empty}>No attachments or external links were included with this notice.</p></Card>}

    </div>
    {dismissedPrompt && <Modal title="Opportunity dismissed" onClose={() => setDismissedPrompt(false)} footer={<>
      <button className="btn" onClick={() => setDismissedPrompt(false)}>Stay here</button>
      <button className="btn btn-primary" autoFocus onClick={() => navigate(returnTo)}>Back to opportunities</button>
    </>}><p className="text-sm">This opportunity is hidden from the active SAM.gov list.</p></Modal>}
  </>
}
