import { useCallback, useEffect, useRef, useState } from 'react'
import styles from './DocumentAnalysisPanel.module.css'

const STATUS_LABELS = {
  searching: 'Searching documents', preliminary: 'Preliminary', cited: 'Cited',
  needs_review: 'Needs review', conflict: 'Conflicting instructions',
  not_found: 'Not found', cancelled: 'Cancelled', error: 'Needs attention',
  partial: 'Incomplete', processing: 'Processing', not_analyzed: 'Not analyzed',
}

function findingKey(item) { return [item?.citation?.fileName, item?.citation?.location, item?.text].filter(Boolean).join('|') }

function ReviewControl({ item, reviews, onReview }) {
  if (!onReview || !item) return null
  const current = reviews?.[findingKey(item)]?.status || 'unreviewed'
  return <select className={styles.review} aria-label="Review finding" value={current} onChange={(event) => onReview(item, event.target.value)}>
    <option value="unreviewed">Unreviewed</option><option value="confirmed">Confirmed</option><option value="incorrect">Incorrect</option><option value="not_applicable">Not applicable</option><option value="corrected">Corrected</option>
  </select>
}

function Finding({ label, items, status, reviews, onReview }) {
  const first = items?.[0]
  const sourceLabel = first?.verification === 'structured_source'
    ? 'Structured opportunity source'
    : first?.verification === 'ai_validated'
      ? 'AI-validated cited evidence'
      : 'Cited evidence—review recommended'
  return <div className={styles.finding}>
    <span>{label}</span>
    {first ? <>
      <p>{first.text}</p>
      <small>{first.citation?.fileName}{first.citation?.location ? ` · ${first.citation.location}` : ''}{` · ${sourceLabel}`}</small>
      <ReviewControl item={first} reviews={reviews} onReview={onReview} />
      {items.length > 1 && <details><summary>{items.length - 1} more cited finding{items.length === 2 ? '' : 's'}</summary>{items.slice(1).map((item, index) => <div className={styles.more} key={`${item.text}-${index}`}><p>{item.text}</p><small>{item.citation?.fileName}{item.citation?.location ? ` · ${item.citation.location}` : ''}</small></div>)}</details>}
    </> : <strong>{status === 'not_found' ? 'NOT FOUND' : status === 'cancelled' ? 'CANCELLED' : status === 'error' ? 'ANALYSIS NEEDS ATTENTION' : status === 'partial' ? 'NOT FOUND YET' : status === 'not_analyzed' ? 'NOT ANALYZED' : 'PROCESSING DOCUMENTS…'}</strong>}
  </div>
}

const TOPIC_LABELS = {
  submission: 'Proposal submission', questions: 'Questions', evaluation: 'Evaluation', scope: 'Scope of work',
  deliverables: 'Deliverables', pricing: 'Pricing', performance: 'Performance requirements',
  staffing_security: 'Staffing and security', past_performance: 'Past performance',
  forms_attachments: 'Required forms and attachments', contract_structure: 'Contract structure', risks_changes: 'Risks and changes',
}
const DOCUMENT_TYPE_LABELS = {
  solicitation: 'Solicitation', instructions: 'Instructions', statement_of_work: 'Statement of work', evaluation: 'Evaluation',
  pricing: 'Pricing', amendment: 'Amendment', questions_answers: 'Questions and answers', supporting: 'Supporting document', other: 'Document',
}

function ReadableSummary({ text }) {
  const paragraphs = String(text || '').split(/\n{2,}/).map((item) => item.trim()).filter(Boolean)
  return paragraphs.map((paragraph, index) => <p key={`${paragraph}-${index}`}>{paragraph}</p>)
}

function PackageOverview({ analysis }) {
  if (analysis?.status !== 'ready') return null
  const coverage = analysis.coverage || {}
  const metrics = [
    coverage.analyzedDocuments !== undefined && `${coverage.analyzedDocuments} analyzed`,
    coverage.boilerplateSections > 0 && `${coverage.boilerplateSections} standard sections skipped`,
    coverage.excludedTemplates > 0 && `${coverage.excludedTemplates} templates excluded`,
    coverage.issueDocuments > 0 && `${coverage.issueDocuments} need attention`,
  ].filter(Boolean)
  const overviewPoints = (analysis.overviewPoints || []).filter(Boolean)
  return <section className={styles.packageOverview}>
    <div className={styles.packageHeader}>
      <span><small>PACKAGE OVERVIEW</small><strong>What the opportunity documents say</strong></span>
      {metrics.length > 0 && <div className={styles.coverage}>{metrics.map((metric) => <em key={metric}>{metric}</em>)}</div>}
    </div>
    {overviewPoints.length > 0
      ? <ul className={styles.overviewList}>{overviewPoints.map((point, index) => <li key={`${point}-${index}`}>{point}</li>)}</ul>
      : analysis.overview && <div className={styles.overview}><ReadableSummary text={analysis.overview} /></div>}
    {analysis.agencyNeed && <p className={styles.agencyNeed}><strong>Agency need:</strong> {analysis.agencyNeed}</p>}
  </section>
}

function DocumentGuides({ guides }) {
  if (!guides.length) return null
  return <section className={styles.documentGuides}>
    <div className={styles.sectionHeading}><small>DOCUMENT GUIDE</small><strong>Where to find the important information</strong></div>
    {guides.map((guide) => <article className={styles.documentGuide} key={`${guide.filePath || ''}-${guide.fileName}`}>
      <header><strong>{guide.fileName}</strong><span>{DOCUMENT_TYPE_LABELS[guide.documentType] || 'Document'}</span></header>
      {guide.summary && <div className={styles.guideSummary}><ReadableSummary text={guide.summary} /></div>}
      {(guide.keyPoints || []).length > 0 && <ul className={styles.keyPoints}>{guide.keyPoints.map((point, index) => <li key={`${point}-${index}`}>{point}</li>)}</ul>}
      {(guide.locations || []).length > 0 && <div className={styles.locationMap}>{guide.locations.map((item, index) => <div key={`${item.topic}-${item.description}-${index}`}>
        <strong>{TOPIC_LABELS[item.topic] || item.topic}</strong>
        <p>{item.description}</p>
        <small>Go to: {(item.locations || []).join(' · ')}</small>
      </div>)}</div>}
    </article>)}
  </section>
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
      if (error.status !== 404) toast?.error(`Document analysis could not load: ${error.message}`)
    } finally { setLoading(false) }
  }, [toast])

  useEffect(() => { refresh().catch(() => {}) }, [refresh])

  const status = analysis?.critical?.status || (disabled ? 'cancelled' : 'searching')
  useEffect(() => {
    if (status !== 'processing') return undefined
    const timer = window.setInterval(() => refresh().catch(() => {}), 8_000)
    return () => window.clearInterval(timer)
  }, [refresh, status])

  const start = async () => {
    setRunning(true)
    try {
      // Keep one click to one bounded server batch. Chaining every remaining
      // document into one browser action made large packages prone to an
      // interrupted connection and a generic "Failed to fetch" error.
      const result = await runRef.current()
      setAnalysis(result.analysis || null)
      if (result.run?.started || result.analysis?.critical?.status === 'processing') {
        toast?.info('Document analysis is processing in the background')
        return
      }
      const processed = Number(result.run?.opportunity?.processed || 0)
      const remaining = Number(result?.run?.opportunity?.remaining || 0)
      const deferred = Number(result?.run?.opportunity?.deferred || 0)
      const analysisPaused = deferred || (result?.run?.state?.status === 'partial' && !remaining)
      if (analysisPaused) toast?.info('AI validation paused before analysis completed. Click Analyze documents again later.')
      else if (remaining) toast?.info(`${processed} document${processed === 1 ? '' : 's'} analyzed; ${remaining} remain. Click Analyze documents again.`)
      else toast?.success('Document analysis is available')
    } catch (error) {
      // A completed batch is saved server-side before the response returns.
      // Reload any saved progress so the panel never remains falsely stuck in
      // its pre-request "Searching documents" state after a network break.
      await refresh().catch(() => {})
      const interrupted = /failed to fetch|network|load failed/i.test(error?.message || '')
      toast?.error(interrupted
        ? 'Document analysis was interrupted. Any completed progress was saved; click Analyze documents again.'
        : `Documents could not be analyzed: ${error.message}`)
    }
    finally { setRunning(false) }
  }
  const saveReview = async (item, status) => {
    if (!reviewRef.current) return
    let correctedText = ''
    if (status === 'corrected') {
      correctedText = window.prompt('Enter the corrected finding', item.text) || ''
      if (!correctedText.trim()) return
    }
    try {
      const result = await reviewRef.current({ findingKey: findingKey(item), status, correctedText })
      setAnalysis(result.analysis || null)
    } catch (error) { toast?.error(`Finding review could not be saved: ${error.message}`) }
  }

  const documents = analysis?.documents || []
  const documentIssues = documents.flatMap((document) => {
    const messages = []
    if (['unsupported', 'error'].includes(document.status)) messages.push(document.error || (document.status === 'unsupported' ? 'This file format is not supported.' : 'This file could not be analyzed.'))
    for (const warning of document.analysis?.warnings || []) messages.push(warning)
    return [...new Set(messages.filter(Boolean))].map((message) => ({ fileName: document.fileName, filePath: document.filePath, message }))
  })
  const analyzedDocuments = documents.filter((document) => document.status === 'ready')
  const excludedTemplates = documents.filter((document) => document.status === 'excluded_template')
  const documentGuides = analysis?.package?.documentGuides || analyzedDocuments.map((document) => ({
    fileName: document.fileName,
    documentType: document.analysis?.documentType || 'other',
    summary: document.analysis?.overview || document.summary,
    keyPoints: document.analysis?.keyPoints || [],
    locations: document.analysis?.documentMap || [],
  }))

  return <section className={styles.panel}>
    <header>
      <button type="button" className={styles.heading} onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        <span><small>DOCUMENT INTELLIGENCE</small><strong>Critical dates and submission instructions</strong></span>
        <span className={styles.headerRight}><em data-status={status}>{STATUS_LABELS[status] || status}</em><b aria-hidden="true">{open ? '⌃' : '⌄'}</b></span>
      </button>
    </header>
    {open && <div className={styles.body}>
      <div className={styles.actions}>
        <p>{analysis?.job?.phase || (loading ? 'Loading analysis…' : 'Archived documents have not been analyzed yet.')}</p>
        <button className="btn" type="button" disabled={disabled || running || status === 'processing'} onClick={start}>{running || status === 'processing' ? 'Processing…' : 'Analyze documents'}</button>
      </div>
      <div className={styles.grid}>
        <Finding label="Questions due" items={analysis?.critical?.questions?.deadlines} status={status} reviews={analysis?.reviews} onReview={review ? saveReview : null} />
        <Finding label="Questions recipient or submission method" items={analysis?.critical?.questions?.submissionInstructions} status={status} reviews={analysis?.reviews} onReview={review ? saveReview : null} />
        <Finding label="Proposal recipient or submission method" items={analysis?.critical?.proposals?.submissionInstructions} status={status} reviews={analysis?.reviews} onReview={review ? saveReview : null} />
      </div>
      {(analysis?.critical?.conflicts || []).length > 0 && <div className={styles.warning}>
        <strong>Conflicting instructions found.</strong> The highest-ranked current source is shown. Review the cited alternatives before submission.
        <details><summary>Show conflicting evidence</summary>{analysis.critical.conflicts.map((conflict) => <div className={styles.conflict} key={conflict.category}>
          <b>{conflict.category.replace('.', ' · ')}</b>
          {(conflict.alternatives || []).map((item, index) => <div key={`${item.text}-${index}`}><p>{item.text}</p><small>{item.citation?.fileName}{item.citation?.location ? ` · ${item.citation.location}` : ''}</small></div>)}
        </div>)}</details>
      </div>}
      {documentIssues.length > 0 && <div className={styles.warning}>
        <strong>{documentIssues.length} document issue{documentIssues.length === 1 ? '' : 's'} need attention.</strong> Results from the other files remain available.
        <ul className={styles.issueList}>{documentIssues.map((issue, index) => <li key={`${issue.fileName}-${issue.message}-${index}`}>
          <b>{issue.fileName || issue.filePath || 'Unknown file'}</b><span>{issue.message}</span>
        </li>)}</ul>
      </div>}
      <PackageOverview analysis={analysis?.package} />
      <DocumentGuides guides={documentGuides} />
      {excludedTemplates.length > 0 && <section className={styles.fileList}><strong>{excludedTemplates.length} submission template{excludedTemplates.length === 1 ? '' : 's'} excluded</strong>
        {excludedTemplates.map((document) => <div key={`${document.filePath}-${document.fileName}`}><b>{document.fileName}</b><small>Retained in SharePoint for later drafting; excluded from opportunity analysis.</small></div>)}
      </section>}
      {(analysis?.pastPerformance || []).length > 0 && <section className={styles.fileList}><strong>{analysis.pastPerformance.length} past-performance match{analysis.pastPerformance.length === 1 ? '' : 'es'}</strong>{analysis.pastPerformance.slice(0, 8).map((match) => <div key={match.fileName}><b>{match.fileName} · {match.score}% match</b><small>{[match.serviceCategory, ...(match.evidence || [])].filter(Boolean).join(' · ')}</small></div>)}</section>}
    </div>}
  </section>
}
