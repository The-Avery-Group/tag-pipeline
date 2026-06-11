import { useState, useCallback } from 'react'
import { groqChat } from '@/services/groqService'
import styles from './AIPanel.module.css'

/**
 * AIPanel
 * Props:
 *   buildPrompt: () => messages[]  — called lazily when user expands
 *   title: string
 *   defaultCollapsed: bool
 */
export default function AIPanel({ buildPrompt, title = 'AI summary', defaultCollapsed = true }) {
  const [open, setOpen] = useState(!defaultCollapsed)
  const [content, setContent] = useState('')
  const [modelUsed, setModelUsed] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [fetched, setFetched] = useState(false)

  const fetchSummary = useCallback(async () => {
    if (fetched) return
    setLoading(true)
    setError(null)
    try {
      const messages = buildPrompt()
      const { content: text, model } = await groqChat(messages, { maxTokens: 300 })
      setContent(text)
      setModelUsed(model)
      setFetched(true)
    } catch (err) {
      if (err.name !== 'AbortError') setError('Failed to generate summary.')
    } finally {
      setLoading(false)
    }
  }, [buildPrompt, fetched])

  const toggle = () => {
    const next = !open
    setOpen(next)
    if (next && !fetched) fetchSummary()
  }

  const regenerate = () => {
    setFetched(false)
    setContent('')
    fetchSummary()
  }

  return (
    <div className={styles.panel}>
      <button className={styles.header} onClick={toggle} aria-expanded={open}>
        <span className={styles.sparkIcon} aria-hidden="true">✦</span>
        <span className={styles.headerTitle}>{title}</span>
        <span className={styles.headerHint}>{open ? 'Collapse' : 'Click to expand'}</span>
        <span className={`${styles.chevron} ${open ? styles.chevronOpen : ''}`} aria-hidden="true">›</span>
      </button>

      {open && (
        <div className={styles.body}>
          {loading && (
            <div className={styles.loading}>
              <span className={styles.dot} /><span className={styles.dot} /><span className={styles.dot} />
              <span className={styles.loadingText}>Generating summary…</span>
            </div>
          )}
          {error && <p className={styles.error}>{error}</p>}
          {!loading && !error && content && (
            <>
              <p className={styles.content}>{content}</p>
              <div className={styles.meta}>
                {modelUsed && <span className={styles.modelLabel}>Generated with {modelUsed}</span>}
                <button className={styles.regenBtn} onClick={regenerate}>↺ Regenerate</button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}
