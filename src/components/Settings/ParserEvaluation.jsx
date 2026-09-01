import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  getParserEvaluationAccess,
  getParserEvaluationReport,
  reviewParserEvaluationDocument,
  startParserEvaluation,
} from '@/services/parserEvaluationService'
import styles from './ParserEvaluation.module.css'

const ACTIVE_STATUSES = new Set(['queued', 'running'])
const DECISIONS = [
  ['cloudflare', 'Cloudflare is better'],
  ['existing', 'Existing is better'],
  ['both', 'Both are complete'],
  ['neither', 'Both are incomplete'],
  ['insufficient', 'Not enough information'],
]

function bytes(value) {
  const amount = Number(value || 0)
  if (!amount) return 'Size unavailable'
  if (amount >= 1024 * 1024) return `${(amount / (1024 * 1024)).toFixed(1)} MB`
  return `${Math.round(amount / 1024)} KB`
}

function metric(metrics, key) {
  return Number(metrics?.[key] || 0).toLocaleString()
}

function formatTime(value) {
  const date = value ? new Date(value) : null
  return date && !Number.isNaN(date.getTime())
    ? date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
    : 'Not available'
}

function recommendationLabel(value) {
  return ({ cloudflare: 'Cloudflare leads', existing: 'Existing leads', review: 'Review required', neither: 'Neither succeeded' })[value] || 'Pending comparison'
}

function ParserPreview({ title, preview, metrics, error }) {
  return <section className={styles.preview}>
    <div className={styles.previewHeader}>
      <strong>{title}</strong>
      <span>{metric(metrics, 'characters')} characters · {metric(metrics, 'tableRows')} table rows · {metric(metrics, 'emails')} emails · {metric(metrics, 'durationMs')} ms</span>
    </div>
    {error ? <p className={styles.error}>{error}</p>
      : preview ? <pre>{preview}</pre>
        : <p className={styles.muted}>No preview was produced.</p>}
  </section>
}

function DocumentComparison({ document, onReviewed, onReviewError }) {
  const [decision, setDecision] = useState(document.reviewDecision || '')
  const [notes, setNotes] = useState(document.reviewNotes || '')
  const [saving, setSaving] = useState(false)
  const comparison = document.comparison || {}

  const save = async () => {
    if (!decision || saving) return
    setSaving(true)
    try {
      await reviewParserEvaluationDocument(document.id, decision, notes)
      onReviewed(document.id, { reviewDecision: decision, reviewNotes: notes, reviewedAt: new Date().toISOString() })
    } catch (error) {
      onReviewError?.(error)
    } finally {
      setSaving(false)
    }
  }

  return <details className={styles.document}>
    <summary>
      <span>
        <strong>{document.fileName}</strong>
        <small>{document.opportunityTitle || document.opportunityKey} · {document.sourceService.toUpperCase()} · {bytes(document.byteSize)}</small>
      </span>
      <span className={`${styles.recommendation} ${styles[comparison.recommendation] || ''}`}>{recommendationLabel(comparison.recommendation)}</span>
    </summary>
    <div className={styles.documentBody}>
      {document.error && <p className={styles.error}>{document.error}</p>}
      <div className={styles.comparisonFacts}>
        <span>Baseline vocabulary retained <strong>{Math.round(Number(comparison.baselineCoverage || 0) * 100)}%</strong></span>
        <span>Relative output length <strong>{Number(comparison.lengthRatio || 0).toFixed(2)}×</strong></span>
        <span>Missing signals <strong>{comparison.missingSignals?.join(', ') || 'None detected'}</strong></span>
      </div>
      <div className={styles.previews}>
        <ParserPreview title="Existing parser" preview={document.existingPreview} metrics={document.existingMetrics} error={comparison.existingError} />
        <ParserPreview title="Cloudflare toMarkdown" preview={document.cloudflarePreview} metrics={document.cloudflareMetrics} error={comparison.cloudflareError} />
      </div>
      <div className={styles.review}>
        <label>
          <span>Reviewer decision</span>
          <select className="form-input" value={decision} onChange={(event) => setDecision(event.target.value)}>
            <option value="">Choose after reviewing</option>
            {DECISIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
        <label className={styles.notes}>
          <span>Notes</span>
          <input className="form-input" value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="Optional observation" />
        </label>
        <button type="button" className="btn btn-primary" onClick={save} disabled={!decision || saving}>{saving ? 'Saving…' : document.reviewedAt ? 'Update review' : 'Save review'}</button>
      </div>
    </div>
  </details>
}

export default function ParserEvaluation({ toast }) {
  const [access, setAccess] = useState(null)
  const [report, setReport] = useState({ run: null, documents: [] })
  const [loading, setLoading] = useState(true)
  const [starting, setStarting] = useState(false)
  const pollingRef = useRef(null)

  const load = useCallback(async (quiet = false) => {
    try {
      const result = await getParserEvaluationReport()
      setReport(result)
      return result
    } catch (error) {
      if (!quiet) toast?.error(`Could not load parser evaluation: ${error.message}`)
      return null
    }
  }, [toast])

  useEffect(() => {
    let active = true
    getParserEvaluationAccess()
      .then(async (value) => {
        if (!active) return
        setAccess(value)
        if (value.allowed && value.ready) await load(true)
      })
      .catch(() => active && setAccess({ allowed: false, configured: false, ready: false }))
      .finally(() => active && setLoading(false))
    return () => { active = false }
  }, [load])

  useEffect(() => {
    if (pollingRef.current) clearInterval(pollingRef.current)
    if (!ACTIVE_STATUSES.has(report.run?.status)) return undefined
    pollingRef.current = setInterval(() => load(true), 6000)
    return () => clearInterval(pollingRef.current)
  }, [report.run?.status, load])

  const start = async () => {
    if (starting || ACTIVE_STATUSES.has(report.run?.status)) return
    setStarting(true)
    try {
      const run = await startParserEvaluation({ sampleOpportunities: 10, filesPerOpportunity: 4 })
      toast?.success(`Parser evaluation started for ${run.totalDocuments} documents`)
      await load(true)
    } catch (error) {
      toast?.error(`Could not start parser evaluation: ${error.message}`)
    } finally {
      setStarting(false)
    }
  }

  const reviewCounts = useMemo(() => report.documents.reduce((counts, document) => {
    if (document.reviewDecision) counts.reviewed += 1
    else if (document.status === 'complete') counts.remaining += 1
    return counts
  }, { reviewed: 0, remaining: 0 }), [report.documents])

  const onReviewed = (documentId, patch) => setReport((current) => ({
    ...current,
    documents: current.documents.map((document) => document.id === documentId ? { ...document, ...patch } : document),
  }))

  if (loading) return <div className={styles.body}><p className={styles.muted}>Checking evaluation access…</p></div>
  if (!access?.allowed) return null
  if (!access.ready) return <div className={styles.body}><p className={styles.error}>The parser-evaluation database migration has not been applied yet.</p></div>

  const run = report.run
  const progress = run?.totalDocuments ? Math.round((run.processedDocuments / run.totalDocuments) * 100) : 0
  return <div className={styles.body}>
    <div className={styles.intro}>
      <div>
        <strong>Cloudflare parser evaluation</strong>
        <p>Compares archived files read-only. It does not replace live document analysis or modify SharePoint.</p>
      </div>
      <div className={styles.actions}>
        <button type="button" className="btn" onClick={() => load()} disabled={loading}>Refresh</button>
        <button type="button" className="btn btn-primary" onClick={start} disabled={starting || ACTIVE_STATUSES.has(run?.status)}>{starting ? 'Starting…' : run ? 'Run another evaluation' : 'Start evaluation'}</button>
      </div>
    </div>

    {!run ? <p className={styles.muted}>No evaluation has run yet. Start the test before changing the production parser.</p> : <>
      <div className={styles.runSummary}>
        <div><span>Status</span><strong>{run.progressPhase}</strong></div>
        <div><span>Progress</span><strong>{run.processedDocuments} of {run.totalDocuments} documents</strong></div>
        <div><span>Opportunities</span><strong>{run.totalOpportunities}</strong></div>
        <div><span>Human review</span><strong>{reviewCounts.reviewed} reviewed · {reviewCounts.remaining} remaining</strong></div>
      </div>
      {ACTIVE_STATUSES.has(run.status) && <div className={styles.progress}><span style={{ width: `${progress}%` }} /></div>}
      {run.error && <p className={styles.error}>{run.error}</p>}
      <p className={styles.timestamp}>Started {formatTime(run.startedAt || run.createdAt)}{run.completedAt ? ` · Completed ${formatTime(run.completedAt)}` : ''}</p>
      <div className={styles.documents}>
        {report.documents.map((document) => <DocumentComparison
          key={document.id}
          document={document}
          onReviewed={onReviewed}
          onReviewError={(error) => toast?.error(`Could not save review: ${error.message}`)}
        />)}
      </div>
    </>}
  </div>
}
