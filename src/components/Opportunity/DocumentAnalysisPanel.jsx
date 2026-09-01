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

const PACKAGE_GROUPS = [
  { label: 'Contract', fields: ['contractStructure'] },
  { label: 'Submission', fields: ['responsePlan'] },
  { label: 'Evaluation', fields: ['evaluation'] },
  { label: 'Scope and deliverables', fields: ['scopeAndDeliverables'] },
  { label: 'Staffing, security and risks', fields: ['risksAndPackageIssues'] },
  { label: 'Package conflicts', fields: ['conflicts'] },
]

function PackageFinding({ finding, index }) {
  const text = typeof finding === 'string' ? finding : finding?.text
  if (!text) return null
  const citation = typeof finding === 'object' ? [finding.fileName, finding.location].filter(Boolean).join(' · ') : ''
  return <li key={`${text}-${index}`}><p>{text}</p>{citation && <small>{citation}</small>}</li>
}

function PackageOverview({ analysis }) {
  if (analysis?.status !== 'ready') return null
  const coverage = analysis.coverage || {}
  const metrics = [
    coverage.analyzedDocuments !== undefined && `${coverage.analyzedDocuments} analyzed`,
    coverage.totalSections > 0 && `${coverage.completedSections}/${coverage.totalSections} sections`,
    coverage.excludedTemplates > 0 && `${coverage.excludedTemplates} templates excluded`,
    coverage.issueDocuments > 0 && `${coverage.issueDocuments} need attention`,
  ].filter(Boolean)
  return <section className={styles.packageOverview}>
    <div className={styles.packageHeader}>
      <span><small>PACKAGE OVERVIEW</small><strong>What the opportunity documents say</strong></span>
      {metrics.length > 0 && <div className={styles.coverage}>{metrics.map((metric) => <em key={metric}>{metric}</em>)}</div>}
    </div>
    {analysis.overview && <p className={styles.overview}>{analysis.overview}</p>}
    {analysis.agencyNeed && <p className={styles.agencyNeed}><strong>Agency need:</strong> {analysis.agencyNeed}</p>}
    <div className={styles.packageGroups}>
      {PACKAGE_GROUPS.map((group) => {
        const findings = group.fields.flatMap((field) => analysis[field] || []).filter((finding) => typeof finding === 'string' ? finding.trim() : finding?.text)
        if (!findings.length) return null
        return <details key={group.label} className={styles.packageGroup}>
          <summary><span>{group.label}</span><b>{findings.length}</b></summary>
          <ul>{findings.map((finding, index) => <PackageFinding finding={finding} index={index} key={`${group.label}-${typeof finding === 'string' ? finding : finding?.text}-${index}`} />)}</ul>
        </details>
      })}
    </div>
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
      {analyzedDocuments.length > 0 && <details className={styles.requirements}><summary>{analyzedDocuments.length} analyzed document{analyzedDocuments.length === 1 ? '' : 's'}</summary>
        {analyzedDocuments.map((document) => <article key={`${document.filePath}-${document.fileName}`}>
          <p><strong>{document.fileName}</strong></p>
          <p>{document.summary || 'Analysis completed; no additional summary was extracted from this file.'}</p>
          {document.analysis?.coverage && <small>{document.analysis.coverage.completedChunks} of {document.analysis.coverage.chunkCount} analysis sections completed</small>}
        </article>)}
      </details>}
      {excludedTemplates.length > 0 && <details className={styles.requirements}><summary>{excludedTemplates.length} submission template{excludedTemplates.length === 1 ? '' : 's'} excluded</summary>
        {excludedTemplates.map((document) => <article key={`${document.filePath}-${document.fileName}`}><p><strong>{document.fileName}</strong></p><small>Retained in SharePoint for later drafting; excluded from opportunity analysis.</small></article>)}
      </details>}
      {(analysis?.pastPerformance || []).length > 0 && <details className={styles.requirements}><summary>{analysis.pastPerformance.length} past-performance match{analysis.pastPerformance.length === 1 ? '' : 'es'}</summary>{analysis.pastPerformance.slice(0, 8).map((match) => <article key={match.fileName}><p><strong>{match.fileName}</strong> · {match.score}% match</p><small>{[match.serviceCategory, ...(match.evidence || [])].filter(Boolean).join(' · ')}</small></article>)}</details>}
    </div>}
  </section>
}
