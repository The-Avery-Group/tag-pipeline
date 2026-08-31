import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import styles from './DocumentAnalysisPanel.module.css'

const STATUS_LABELS = {
  searching: 'Searching documents', preliminary: 'Preliminary', cited: 'Cited',
  needs_review: 'Needs review', conflict: 'Conflicting instructions',
  not_found: 'Not found', cancelled: 'Cancelled', error: 'Needs attention',
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
    </> : <strong>{status === 'not_found' ? 'NOT FOUND' : status === 'cancelled' ? 'CANCELLED' : status === 'error' ? 'ANALYSIS NEEDS ATTENTION' : 'Searching documents…'}</strong>}
  </div>
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

  const jobStatus = analysis?.job?.status || ''
  useEffect(() => {
    if (!['queued', 'running'].includes(jobStatus)) return undefined
    const interval = window.setInterval(() => refresh().catch(() => {}), 10_000)
    return () => window.clearInterval(interval)
  }, [jobStatus, refresh])

  const status = analysis?.critical?.status || (disabled ? 'cancelled' : 'searching')
  const requirements = useMemo(() => (analysis?.requirements || []).slice(0, 12), [analysis])
  const deepDocuments = useMemo(() => (analysis?.documents || []).filter((document) => document.analysis?.status === 'ready'), [analysis])
  const start = async () => {
    setRunning(true)
    try {
      const result = await runRef.current()
      setAnalysis(result.analysis || null)
      const pending = ['queued', 'running'].includes(result.analysis?.job?.status) || result.run?.opportunity?.remaining || result.run?.opportunity?.deferred
      toast?.success(pending ? 'Document batch analyzed; remaining documents will continue automatically' : 'Document analysis is available')
    } catch (error) { toast?.error(`Documents could not be analyzed: ${error.message}`) }
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
        <button className="btn" type="button" disabled={disabled || running} onClick={start}>{running ? 'Analyzing…' : 'Analyze documents'}</button>
      </div>
      <div className={styles.grid}>
        <Finding label="Questions due" items={analysis?.critical?.questions?.deadlines} status={status} reviews={analysis?.reviews} onReview={review ? saveReview : null} />
        <Finding label="Questions recipient or submission method" items={analysis?.critical?.questions?.submissionInstructions} status={status} reviews={analysis?.reviews} onReview={review ? saveReview : null} />
        <Finding label="Proposal due" items={analysis?.critical?.proposals?.deadlines} status={status} reviews={analysis?.reviews} onReview={review ? saveReview : null} />
        <Finding label="Proposal recipient or submission method" items={analysis?.critical?.proposals?.submissionInstructions} status={status} reviews={analysis?.reviews} onReview={review ? saveReview : null} />
      </div>
      {(analysis?.critical?.conflicts || []).length > 0 && <div className={styles.warning}>
        <strong>Conflicting instructions found.</strong> The highest-ranked current source is shown. Review the cited alternatives before submission.
        <details><summary>Show conflicting evidence</summary>{analysis.critical.conflicts.map((conflict) => <div className={styles.conflict} key={conflict.category}>
          <b>{conflict.category.replace('.', ' · ')}</b>
          {(conflict.alternatives || []).map((item, index) => <div key={`${item.text}-${index}`}><p>{item.text}</p><small>{item.citation?.fileName}{item.citation?.location ? ` · ${item.citation.location}` : ''}</small></div>)}
        </div>)}</details>
      </div>}
      {(analysis?.documents || []).some((document) => ['unsupported', 'error'].includes(document.status)) && <div className={styles.warning}><strong>Some documents need attention.</strong> The available files were still analyzed.</div>}
      {analysis?.package?.status === 'ready' && <details className={styles.requirements} open><summary>Package-wide summary</summary><article>
        {analysis.package.overview && <p><strong>Overview:</strong> {analysis.package.overview}</p>}
        {analysis.package.agencyNeed && <p><strong>Agency need:</strong> {analysis.package.agencyNeed}</p>}
        {['contractStructure', 'responsePlan', 'evaluation', 'scopeAndDeliverables', 'risksAndPackageIssues', 'conflicts'].flatMap((field) => analysis.package[field] || []).slice(0, 30).map((finding, index) => {
          const text = typeof finding === 'string' ? finding : finding?.text
          return <div key={`${text}-${index}`}><p>• {text}</p>{typeof finding === 'object' && (finding.fileName || finding.location) && <small>{[finding.fileName, finding.location].filter(Boolean).join(' · ')}</small>}</div>
        })}
      </article></details>}
      {deepDocuments.length > 0 && <details className={styles.requirements}><summary>Opportunity overview and full findings</summary>{deepDocuments.map((document) => <article key={document.fileName}>
        <p><strong>{document.fileName}</strong>{document.analysis.overview ? `: ${document.analysis.overview}` : ''}</p>
        {['contractStructure', 'performance', 'responseRequirements', 'evaluation', 'scopeAndDeliverables', 'staffingAndSecurity', 'packageIssues'].flatMap((field) => document.analysis[field] || []).slice(0, 24).map((finding, index) => {
          const text = typeof finding === 'string' ? finding : finding?.text
          const location = typeof finding === 'object' ? finding?.location : ''
          return <div key={`${text}-${index}`}><p>• {text}</p>{location && <small>{document.fileName} · {location}</small>}</div>
        })}
      </article>)}</details>}
      {requirements.length > 0 && <details className={styles.requirements}><summary>{analysis.requirements.length} cited requirement{analysis.requirements.length === 1 ? '' : 's'}</summary>{requirements.map((item, index) => <article key={`${item.text}-${index}`}><p>{analysis?.reviews?.[findingKey(item)]?.status === 'corrected' ? analysis.reviews[findingKey(item)].correctedText : item.text}</p><small>{item.citation?.fileName} · {item.citation?.location}</small><ReviewControl item={item} reviews={analysis?.reviews} onReview={review ? saveReview : null} /></article>)}{analysis.requirements.length > requirements.length && <p>Showing the first {requirements.length} findings.</p>}</details>}
      {(analysis?.pastPerformance || []).length > 0 && <details className={styles.requirements}><summary>{analysis.pastPerformance.length} past-performance match{analysis.pastPerformance.length === 1 ? '' : 'es'}</summary>{analysis.pastPerformance.slice(0, 8).map((match) => <article key={match.fileName}><p><strong>{match.fileName}</strong> · {match.score}% match</p><small>{[match.serviceCategory, ...(match.evidence || [])].filter(Boolean).join(' · ')}</small></article>)}</details>}
    </div>}
  </section>
}
