import { useCallback, useEffect, useRef, useState } from 'react'
import styles from './DocumentAnalysisPanel.module.css'

const STATUS_LABELS = {
  ready: 'Ready', cancelled: 'Cancelled', error: 'Needs attention', partial: 'Incomplete',
  processing: 'Processing', not_analyzed: 'Not analyzed', searching: 'Searching documents',
}

const BRIEF_SECTIONS = [
  ['purpose_overview', 'Purpose / Opportunity Overview'],
  ['scope', 'Scope'],
  ['contractor_qualifications', 'Contractor Qualifications'],
  ['personnel_requirements', 'Personnel Requirements'],
  ['proposal_structure', 'Proposal Structure'],
  ['evaluation_criteria', 'Evaluation Criteria'],
  ['proposal_submission_poc', 'Proposal Submission & Point of Contact'],
  ['period_of_performance', 'Period of Performance'],
]

function findingKey(item) {
  const citation = item?.citations?.[0] || item?.citation || {}
  return [citation.fileName, citation.location, item?.text].filter(Boolean).join('|')
}

function ReviewControl({ item, reviews, onReview }) {
  if (!onReview || !item) return null
  const current = reviews?.[findingKey(item)]?.status || 'unreviewed'
  return <select className={styles.review} aria-label="Review finding" value={current} onChange={(event) => onReview(item, event.target.value)}>
    <option value="unreviewed">Unreviewed</option>
    <option value="confirmed">Confirmed</option>
    <option value="incorrect">Incorrect</option>
    <option value="not_applicable">Not applicable</option>
    <option value="corrected">Corrected</option>
  </select>
}

function userFacingDocumentIssues(documents = []) {
  return documents.flatMap((document) => {
    if (document.status === 'unsupported') return [{ fileName: document.fileName, message: 'This file type cannot be reviewed automatically.' }]
    if (document.status === 'error') return [{ fileName: document.fileName, message: 'The review could not finish for this document. Run Analyze documents again.' }]
    if (document.status === 'ready' && (
      (document.analysis?.warnings || []).length > 0
      || Number(document.analysis?.coverage?.completedChunks || 0) < Number(document.analysis?.coverage?.chunkCount || 0)
    )) return [{ fileName: document.fileName, message: 'Some sections could not be reviewed. Run Analyze documents again.' }]
    return []
  })
}

function BriefSection({ category, label, section, reviews, onReview }) {
  const items = section?.items || []
  const state = section?.status || 'not_found'
  return <article className={styles.briefSection} data-state={state}>
    <header>
      <strong>{label}</strong>
      <span>{state === 'not_found' ? 'Not found' : state === 'ambiguous' ? 'Review required' : state === 'conflicting' ? 'Conflicting' : 'Found'}</span>
    </header>
    {items.length === 0
      ? <p className={styles.notFound}>Not found in the available documents.</p>
      : <div className={styles.briefItems}>{items.map((item, index) => <div className={styles.briefItem} key={`${category}-${findingKey(item)}-${index}`}>
        <p>{item.text}</p>
        {(item.citations || []).length > 0 && <small>Verify in: {item.citations.map((citation) => [citation.fileName, citation.location].filter(Boolean).join(' · ')).join('; ')}</small>}
        {item.assessment !== 'found' && <em>{item.assessment === 'conflicting' ? 'The source contains conflicting information.' : 'The source is ambiguous; verify before relying on it.'}</em>}
        <ReviewControl item={item} reviews={reviews} onReview={onReview} />
      </div>)}</div>}
  </article>
}

export default function DocumentAnalysisPanel({ load, run, review, disabled = false, toast }) {
  const [analysis, setAnalysis] = useState(null)
  const [loading, setLoading] = useState(true)
  const [running, setRunning] = useState(false)
  const [open, setOpen] = useState(true)
  const loadRef = useRef(load)
  const runRef = useRef(run)
  const reviewRef = useRef(review)
  loadRef.current = load
  runRef.current = run
  reviewRef.current = review

  const refresh = useCallback(async () => {
    try {
      const result = await loadRef.current()
      setAnalysis(result.analysis || null)
    } catch (error) {
      if (error.status !== 404) toast?.error(`Opportunity Brief could not load: ${error.message}`)
    } finally { setLoading(false) }
  }, [toast])

  useEffect(() => { refresh().catch(() => {}) }, [refresh])

  const status = analysis?.status || (disabled ? 'cancelled' : 'searching')
  useEffect(() => {
    if (status !== 'processing') return undefined
    const timer = window.setInterval(() => refresh().catch(() => {}), 8_000)
    return () => window.clearInterval(timer)
  }, [refresh, status])

  const start = async () => {
    setRunning(true)
    try {
      const result = await runRef.current()
      setAnalysis(result.analysis || null)
      if (result.run?.started || result.analysis?.status === 'processing') {
        toast?.info('Opportunity Brief is processing in the background')
        return
      }
      const processed = Number(result.run?.opportunity?.processed || 0)
      const remaining = Number(result?.run?.opportunity?.remaining || 0)
      const deferred = Number(result?.run?.opportunity?.deferred || 0)
      if (deferred || (result?.run?.state?.status === 'partial' && !remaining)) toast?.info('Opportunity Brief processing will continue automatically when AI capacity is available.')
      else if (remaining) toast?.info(`${processed} document${processed === 1 ? '' : 's'} reviewed; ${remaining} remain.`)
      else toast?.success('Opportunity Brief is available')
    } catch (error) {
      await refresh().catch(() => {})
      const interrupted = /failed to fetch|network|load failed/i.test(error?.message || '')
      toast?.error(interrupted
        ? 'Opportunity Brief processing was interrupted. Completed progress was saved; click Analyze documents again.'
        : `Documents could not be analyzed: ${error.message}`)
    } finally { setRunning(false) }
  }

  const saveReview = async (item, reviewStatus) => {
    if (!reviewRef.current) return
    let correctedText = ''
    if (reviewStatus === 'corrected') {
      correctedText = window.prompt('Enter the corrected finding', item.text) || ''
      if (!correctedText.trim()) return
    }
    try {
      const result = await reviewRef.current({ findingKey: findingKey(item), status: reviewStatus, correctedText })
      setAnalysis(result.analysis || null)
    } catch (error) { toast?.error(`Finding review could not be saved: ${error.message}`) }
  }

  const documents = analysis?.documents || []
  const documentIssues = userFacingDocumentIssues(documents)
  const sections = analysis?.package?.sections || []
  const coverage = analysis?.package?.coverage || {}

  return <section className={styles.panel}>
    <header>
      <button type="button" className={styles.heading} onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        <span><small>OPPORTUNITY BRIEF</small><strong>What the opportunity requires and where to verify it</strong></span>
        <span className={styles.headerRight}><em data-status={status}>{STATUS_LABELS[status] || status}</em><b aria-hidden="true">{open ? '⌃' : '⌄'}</b></span>
      </button>
    </header>
    {open && <div className={styles.body}>
      <div className={styles.actions}>
        <p>{analysis?.job?.phase || (loading ? 'Loading Opportunity Brief…' : 'Documents have not been analyzed yet.')}</p>
        <button className="btn" type="button" disabled={disabled || running || status === 'processing'} onClick={start}>{running || status === 'processing' ? 'Processing…' : 'Analyze documents'}</button>
      </div>
      {analysis?.package?.status === 'ready' && <div className={styles.coverage}>
        <em>{Number(coverage.analyzedDocuments || 0)} document{Number(coverage.analyzedDocuments || 0) === 1 ? '' : 's'} reviewed</em>
        {Number(coverage.boilerplateSections || 0) > 0 && <em>{coverage.boilerplateSections} standard sections skipped</em>}
        {Number(coverage.issueDocuments || 0) > 0 && <em>{coverage.issueDocuments} need attention</em>}
      </div>}
      {documentIssues.length > 0 && <div className={styles.warning}>
        <strong>{documentIssues.length} document issue{documentIssues.length === 1 ? '' : 's'} need attention.</strong> Results from the other files remain available.
        <ul className={styles.issueList}>{documentIssues.map((issue, index) => <li key={`${issue.fileName}-${index}`}><b>{issue.fileName || 'Unknown file'}</b><span>{issue.message}</span></li>)}</ul>
      </div>}
      {analysis?.package?.status === 'ready' && <div className={styles.briefGrid}>
        {BRIEF_SECTIONS.map(([category, label]) => <BriefSection
          key={category}
          category={category}
          label={label}
          section={sections.find((item) => item.category === category)}
          reviews={analysis?.reviews}
          onReview={review ? saveReview : null}
        />)}
      </div>}
    </div>}
  </section>
}
