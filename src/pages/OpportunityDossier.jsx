import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import Topbar from '@/components/Layout/Topbar'
import RichText from '@/components/Common/RichText'
import CopyValue from '@/components/Common/CopyValue'
import { usePipeline } from '@/hooks/usePipeline'
import { useNotes } from '@/hooks/useNotes'
import { useTasks } from '@/hooks/useTasks'
import { useContacts } from '@/hooks/useContacts'
import { usePartners } from '@/hooks/usePartners'
import { useOpportunityAlerts } from '@/hooks/useOpportunityAlerts'
import { parsePOCNames } from '@/services/graphService'
import { listOpportunityWorkspaceFlatFiles } from '@/services/opportunityWorkspaceService'
import { analyzeOpportunityDocuments, getOpportunityDocumentAnalysis, reviewOpportunityDocumentFinding } from '@/services/opportunityWorkspaceService'
import DocumentAnalysisPanel from '@/components/Opportunity/DocumentAnalysisPanel'
import { OPPORTUNITY_FILES_CHANGED_EVENT } from '@/services/opportunityReferenceUploadService'
import { formatDate } from '@/utils/kpiHelpers'
import styles from './OpportunityDossier.module.css'

const C = {
  id: 'Contract Number / Notice ID', title: 'Project Title / Description*', department: 'Department*',
  agency: 'Agency*', office: 'Office*', noticeType: 'Notice Type', phase: 'TAG Opportunity Phase',
  activity: 'TAG Pipeline Activity Phase', responseDate: 'Submission Date (Response Date)*',
  naics: 'NAICS Code*', setAside: 'Set- Aside*', classification: 'Contract Classification*',
  assignedTo: 'Assigned To*', poc: 'Contracting Officer / Specialist (POC)*', partner: 'Partner',
  incumbent: 'Incumbent (Company Name)', incumbentUEI: 'Incumbent (Company UEI)',
}

function normalized(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '')
}

function formatBytes(bytes) {
  const size = Number(bytes || 0)
  if (!size) return '—'
  const units = ['B', 'KB', 'MB', 'GB']
  const index = Math.min(Math.floor(Math.log(size) / Math.log(1024)), units.length - 1)
  return `${(size / (1024 ** index)).toFixed(index ? 1 : 0)} ${units[index]}`
}

function Section({ title, children }) {
  return <section className={styles.section}><h2>{title}</h2><div className={styles.sectionBody}>{children}</div></section>
}

function SummaryGrid({ opportunity }) {
  const fields = [
    ['Notice type', C.noticeType], ['Pipeline phase', C.phase], ['Activity', C.activity],
    ['Department', C.department], ['Agency', C.agency], ['Office', C.office],
    ['Response or submission date', C.responseDate], ['NAICS', C.naics],
    ['Set-aside', C.setAside], ['Classification', C.classification], ['Assigned to', C.assignedTo],
  ]
  return <div className={styles.summaryGrid}>{fields.filter(([, key]) => opportunity[key]).map(([label, key]) => {
    const displayValue = key === C.responseDate ? formatDate(opportunity[key]) : opportunity[key]
    return <div key={key} className={styles.summaryItem}><span>{label}</span><CopyValue value={displayValue} label={label}><strong>{displayValue}</strong></CopyValue></div>
  })}</div>
}

export default function OpportunityDossier() {
  const { contractNumber } = useParams()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const opportunityKey = decodeURIComponent(contractNumber || '')
  const { pipeline, loading: pipelineLoading } = usePipeline()
  const { notes, loading: notesLoading } = useNotes(opportunityKey)
  const { tasks, loading: tasksLoading } = useTasks(opportunityKey)
  const { contacts } = useContacts()
  const { partners } = usePartners()
  const alerts = useOpportunityAlerts(opportunityKey)
  const [fileData, setFileData] = useState({ files: [], workspace: null, partial: false })
  const [filesLoading, setFilesLoading] = useState(true)
  const [fileError, setFileError] = useState('')
  const [fileSearch, setFileSearch] = useState('')
  const [fileSource, setFileSource] = useState('All')
  const filesRef = useRef(null)

  const opportunity = useMemo(() => pipeline.find((item) => normalized(item[C.id]) === normalized(opportunityKey)), [opportunityKey, pipeline])
  const linkedContacts = useMemo(() => {
    const names = new Set(parsePOCNames(opportunity?.[C.poc]).map(normalized))
    return contacts.filter((contact) => names.has(normalized(contact.Name)))
  }, [contacts, opportunity])
  const linkedPartners = useMemo(() => {
    if (!opportunity) return []
    const names = String(opportunity[C.partner] || '').split(/[,;\n]/).map(normalized).filter(Boolean)
    const incumbentUEI = normalized(opportunity[C.incumbentUEI])
    return partners.filter((partner) => names.some((name) => normalized(partner['Partner Name']).includes(name) || name.includes(normalized(partner['Partner Name']))) || (incumbentUEI && normalized(partner['UEI Number']) === incumbentUEI))
  }, [opportunity, partners])

  const loadFiles = useCallback(async () => {
    setFilesLoading(true)
    try {
      setFileData(await listOpportunityWorkspaceFlatFiles(opportunityKey))
      setFileError('')
    } catch (error) {
      setFileError(error.message)
    } finally {
      setFilesLoading(false)
    }
  }, [opportunityKey])
  useEffect(() => { loadFiles() }, [loadFiles])
  useEffect(() => {
    const handleFilesChanged = (event) => {
      if (normalized(event.detail?.opportunityKey) === normalized(opportunityKey)) loadFiles()
    }
    window.addEventListener(OPPORTUNITY_FILES_CHANGED_EVENT, handleFilesChanged)
    return () => window.removeEventListener(OPPORTUNITY_FILES_CHANGED_EVENT, handleFilesChanged)
  }, [loadFiles, opportunityKey])

  const visibleFiles = useMemo(() => {
    const query = fileSearch.trim().toLowerCase()
    return (fileData.files || []).filter((file) =>
      (fileSource === 'All' || file.source === fileSource) &&
      (!query || [file.name, file.path, file.mimeType, file.source].some((value) => String(value || '').toLowerCase().includes(query)))
    )
  }, [fileData.files, fileSearch, fileSource])

  const focusedAlert = useMemo(() => {
    const type = searchParams.get('alert')
    return alerts.alerts.find((alert) => alert.type === type) || null
  }, [alerts.alerts, searchParams])
  const changedFileNames = useMemo(() => new Set([
    ...(focusedAlert?.details?.files || []),
    ...(focusedAlert?.details?.changedFiles || []),
    ...(focusedAlert?.details?.removedFiles || []),
  ].map((file) => normalized(file?.name || file?.fileName || file)).filter(Boolean)), [focusedAlert])

  useEffect(() => {
    if (searchParams.get('focus') !== 'files') return
    const timer = window.setTimeout(() => filesRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 120)
    return () => window.clearTimeout(timer)
  }, [searchParams])

  const reviewAlert = async (alert) => {
    if (['sam_files', 'ebuy_files'].includes(alert.type)) {
      const next = new URLSearchParams(searchParams)
      next.set('focus', 'files')
      next.set('alert', alert.type)
      setSearchParams(next, { replace: true })
      window.setTimeout(() => filesRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 40)
    } else if (alert.type === 'rfi_follow_on') {
      navigate(`/opportunities/${encodeURIComponent(opportunityKey)}?focus=follow-ups`)
    }
    await alerts.acknowledge(alert.type, alert.fingerprint).catch(() => {})
  }

  if (pipelineLoading) return <div className="page-body"><div className="skeleton" style={{ height: 44 }} /></div>
  if (!opportunity) return <div className="page-body"><button className="btn btn-ghost" onClick={() => navigate('/opportunities')}>← Opportunities</button><p className="text-muted mt-3">Opportunity not found.</p></div>

  const activeAlerts = alerts.alerts.filter((alert) => alert.badgeVisible)
  return <>
    <Topbar title="Opportunity dossier" subtitle1={opportunity[C.title]} subtitle2={opportunityKey} showFilter={false} showNew={false} />
    <main className={`page-body ${styles.page}`}>
      <div className={styles.toolbar}>
        <button className="btn btn-ghost" onClick={() => navigate(`/opportunities/${encodeURIComponent(opportunityKey)}`)}>← Opportunity</button>
        {fileData.workspace?.webUrl && <a className="btn" href={fileData.workspace.webUrl} target="_blank" rel="noreferrer">Open SharePoint folder</a>}
      </div>

      {activeAlerts.length > 0 && <div className={styles.alertStrip}>
        <strong>Needs review</strong>
        <div>{activeAlerts.map((alert) => <button key={alert.type} type="button" onClick={() => reviewAlert(alert)} title="Open evidence and mark reviewed">{alert.summary || 'Opportunity information changed'}</button>)}</div>
      </div>}

      <Section title="Overview"><SummaryGrid opportunity={opportunity} /></Section>

      <DocumentAnalysisPanel
        load={() => getOpportunityDocumentAnalysis(opportunityKey)}
        run={() => analyzeOpportunityDocuments(opportunityKey)}
        review={(findingReview) => reviewOpportunityDocumentFinding(opportunityKey, findingReview)}
      />

      <Section title="People and relationships">
        <div className={styles.relationshipGrid}>
          <div><h3>Contacts</h3>{linkedContacts.length ? linkedContacts.map((contact) => <div key={contact.ContactID || contact.Email || contact.Name} className={styles.relationship}><strong>{contact.Name}</strong><span>{[contact.Title, contact.Agency].filter(Boolean).join(' · ')}{contact.Email && <>{contact.Title || contact.Agency ? ' · ' : ''}<CopyValue value={contact.Email} label="email address">{contact.Email}</CopyValue></>}</span></div>) : <p className="text-muted text-sm">No linked contacts.</p>}</div>
          <div><h3>Partners</h3>{linkedPartners.length ? linkedPartners.map((partner) => <div key={partner['UEI Number'] || partner['Partner Name']} className={styles.relationship}><strong>{partner['Partner Name']}</strong><span>{partner['UEI Number'] ? <CopyValue value={partner['UEI Number']} label="UEI">{partner['UEI Number']}</CopyValue> : 'UEI unavailable'}</span></div>) : <p className="text-muted text-sm">No linked partners.</p>}</div>
        </div>
      </Section>

      <Section title="Capture intelligence">
        {notesLoading ? <div className="skeleton" style={{ height: 70 }} /> : notes.length ? <div className={styles.noteList}>{notes.map((note) => <article key={note.NoteID || note._rowIndex} className={styles.note}><div><strong>{note.Author || 'Unknown author'}</strong><time>{formatDate(note.Date || note.CreatedDate)}</time></div><RichText value={note.NoteText} /></article>)}</div> : <p className="text-muted text-sm">No notes have been added.</p>}
      </Section>

      <Section title="Tasks and activity">
        {tasksLoading ? <div className="skeleton" style={{ height: 60 }} /> : tasks.length ? <div className={styles.taskList}>{tasks.map((task) => <div key={task.TaskID || task._rowIndex} className={styles.task}><div><strong>{task.Title}</strong><span>{[task.AssignedTo, task.Priority, task.DueDate && `Due ${formatDate(task.DueDate)}`].filter(Boolean).join(' · ')}</span></div><span className="badge badge-tracking">{task.Status || 'To do'}</span></div>)}</div> : <p className="text-muted text-sm">No tasks for this opportunity.</p>}
      </Section>

      <div ref={filesRef} className={styles.focusTarget}><Section title={`Files${fileData.files?.length ? ` · ${fileData.files.length}` : ''}`}>
        {focusedAlert && ['sam_files', 'ebuy_files'].includes(focusedAlert.type) && <div className={styles.fileEvidence}>
          <div><strong>{focusedAlert.summary}</strong><span>{focusedAlert.details?.source || (focusedAlert.type === 'ebuy_files' ? 'GSA eBuy' : 'SAM.gov')} · detected {formatDate(focusedAlert.detectedAt)}</span></div>
          <button className="btn btn-ghost text-xs" onClick={() => alerts.acknowledge(focusedAlert.type, focusedAlert.fingerprint)}>Mark reviewed</button>
        </div>}
        <div className={styles.fileTools}>
          <input className="form-input" value={fileSearch} onChange={(event) => setFileSearch(event.target.value)} placeholder="Search all opportunity files…" />
          <select className="form-select" value={fileSource} onChange={(event) => setFileSource(event.target.value)}><option>All</option><option>Source documents</option><option>Reference material</option><option>Workspace</option></select>
          <button className="btn" onClick={loadFiles} disabled={filesLoading}>{filesLoading ? 'Refreshing…' : 'Refresh'}</button>
        </div>
        {fileError ? <div className="callout callout-error">{fileError}</div> : filesLoading ? <div className="skeleton" style={{ height: 120 }} /> : visibleFiles.length ? <div className={styles.tableWrap}><table className={styles.fileTable}><thead><tr><th>Name</th><th>Source</th><th>Location</th><th>Modified</th><th className={styles.number}>Size</th></tr></thead><tbody>{visibleFiles.map((file) => <tr key={file.id} className={changedFileNames.has(normalized(file.name)) ? styles.changedFile : undefined}><td><a href={file.webUrl} target="_blank" rel="noreferrer">{file.name}</a>{changedFileNames.has(normalized(file.name)) && <span className={styles.changedMarker}>Changed</span>}</td><td><span className={styles.sourceBadge}>{file.source}</span></td><td title={file.folderPath}>{file.folderPath || 'Workspace root'}</td><td>{formatDate(file.lastModifiedDateTime)}</td><td className={styles.number}>{formatBytes(file.size)}</td></tr>)}</tbody></table></div> : <p className="text-muted text-sm">No files match this view.</p>}
        {fileData.partial && <p className="text-muted text-xs" style={{ marginTop: 8 }}>This workspace is unusually large. Open SharePoint to see the remaining files.</p>}
      </Section></div>

    </main>
  </>
}
