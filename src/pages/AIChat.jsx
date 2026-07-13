import { useState, useEffect, useRef, useMemo } from 'react'
import { useSearchParams, useNavigate } from 'react-router-dom'
import { usePipeline } from '@/hooks/usePipeline'
import { useTasks } from '@/hooks/useTasks'
import { useContacts } from '@/hooks/useContacts'
import { useNotes } from '@/hooks/useNotes'
import { useAuth } from '@/auth/AuthContext'
import { useAIChat } from '@/hooks/useAIChat'
import { useAsyncAction } from '@/hooks/useAsyncAction'
import Topbar from '@/components/Layout/Topbar'
import MarkdownText from '@/components/AI/MarkdownText'
import { AI_MODELS, buildPipelineSummaryContext, buildOpportunityContext } from '@/services/groqService'
import { computeKPIs } from '@/utils/kpiHelpers'
import styles from './AIChat.module.css'

const C_CN    = 'Contract Number / Notice ID'
const C_TITLE = 'Project Title / Description*'

// Conversation history must be scoped to the signed-in user. The date keeps
// general conversations short-lived while still allowing a natural back and
// forth throughout a working day.
function makeConvId(userId, base) {
  const safeUser = String(userId || 'current-user').replace(/[^a-zA-Z0-9]/g, '_').slice(0, 48)
  const safeBase = String(base || 'general').replace(/[^a-zA-Z0-9]/g, '_').slice(0, 40)
  return `conv_${safeUser}_${safeBase}_${new Date().toISOString().split('T')[0]}`
}

export function AIChat({ toast }) {
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const { pipeline } = usePipeline()
  const { tasks } = useTasks()
  const { contacts } = useContacts()
  const { notes } = useNotes()
  const { user } = useAuth()
  const [preferredModel, setPreferredModel] = useState(() => {
    try {
      const saved = localStorage.getItem('tag_ai_preferred_model')
      return AI_MODELS.some((model) => model.id === saved) ? saved : AI_MODELS[0].id
    } catch {
      return AI_MODELS[0].id
    }
  })

  const oppCN      = searchParams.get('opportunity')
  const freshParam = searchParams.get('fresh') === '1'

  // Find opportunity if opened from OpportunityDetail
  const opp = useMemo(
    () => oppCN ? pipeline.find((o) => o[C_CN] === oppCN) : null,
    [pipeline, oppCN]
  )

  const promptType = opp ? 'opportunity_detail' : 'general'

  const recentOpportunityNotes = useMemo(() => {
    if (!opp) return ''
    return notes
      .filter((note) => note.ContractNumber === opp[C_CN] && !String(note.NoteText || '').startsWith('[TAG_RELATED_OPPORTUNITY]'))
      .sort((a, b) => new Date(b.Date || 0) - new Date(a.Date || 0))
      .slice(0, 3)
      .map((note) => note.NoteText)
      .filter(Boolean)
      .join(' | ')
  }, [notes, opp])

  // Build context — always include pipeline summary for general chat
  const context = useMemo(() => {
    if (opp) {
      // Opportunity-specific: include the opp details + pipeline summary for broader questions
      return {
        ...buildOpportunityContext(opp, recentOpportunityNotes),
        ...buildPipelineSummaryContext(computeKPIs(pipeline, tasks), pipeline),
      }
    }
    // General chat: full pipeline context so AI can answer any operational question
    return buildPipelineSummaryContext(computeKPIs(pipeline, tasks), pipeline)
  }, [opp, pipeline, tasks, recentOpportunityNotes])

  const convId = useMemo(() => makeConvId(
    user?.id || user?.email,
    opp ? oppCN : 'general'
  ), [user?.id, user?.email, opp, oppCN])

  const { messages, loading, error, historyLoaded, send, startFresh, toolActivity, cancel } = useAIChat({
    conversationId: convId,
    promptType,
    initialContext: context,
    data: { pipeline, tasks, contacts, notes },
    preferredModel,
  })

  const [input, setInput] = useState('')
  const bottomRef = useRef(null)
  const inputRef  = useRef(null)

  useEffect(() => {
    try { localStorage.setItem('tag_ai_preferred_model', preferredModel) } catch {}
  }, [preferredModel])

  // AI Advisor is a conversation surface: keep the composer ready as soon
  // as the page/history is ready and after each completed response.
  useEffect(() => {
    if (!loading && historyLoaded) inputRef.current?.focus()
  }, [loading, historyLoaded])

  // Start fresh if requested via URL param
  useEffect(() => {
    if (freshParam && historyLoaded) {
      startFresh()
      // Remove ?fresh=1 from URL
      const p = new URLSearchParams(searchParams)
      p.delete('fresh')
      navigate({ search: p.toString() }, { replace: true })
    }
  }, [freshParam, historyLoaded])

  // Scroll to bottom on new messages
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, loading])

  const handleSend = () => {
    if (!input.trim() || loading) return
    send(input.trim())
    setInput('')
    inputRef.current?.focus()
  }

  const handleKeyDown = (e) => {
    if (loading) return
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  const clearAction = useAsyncAction()

  const handleStartFresh = async () => {
    try {
      await clearAction.run(() => startFresh())
      toast?.success('Conversation cleared')
    } catch (err) {
      toast?.error(`Failed to clear conversation: ${err.message}`)
    }
  }

  const subtitle = opp
    ? `Discussing: ${opp[C_TITLE]}`
    : 'General pipeline advisor'

  return (
    <>
      <Topbar
        title="AI Advisor"
        subtitle1={subtitle}
        showFilter={false}
        showNew={false}
      />
      <div className={styles.layout}>
        {/* ── Conversation area ── */}
        <div className={styles.messages}>
          {!historyLoaded && (
            <div className={styles.loadingHistory}>
              <span className={styles.dot} />
              <span className={styles.dot} />
              <span className={styles.dot} />
            </div>
          )}

          {historyLoaded && messages.length === 0 && !loading && (
            <div className={styles.empty}>
              <div className={styles.emptyIcon}>✦</div>
              <div className={styles.emptyTitle}>
                {opp ? `Ask anything about ${opp[C_TITLE]}` : 'Ask anything about your pipeline'}
              </div>
              <div className={styles.emptyHint}>
                Try: "What are our highest-risk opportunities?" or "Draft a follow-up for this contract"
              </div>
              {opp && (
                <div className={styles.suggestionRow}>
                  {[
                    'Summarise this opportunity',
                    'What should our win strategy be?',
                    'Are there any red flags?',
                    'Draft a follow-up email',
                  ].map((s) => (
                    <button key={s} className={styles.suggestion} disabled={loading}
                      onClick={() => { send(s) }}>
                      {s}
                    </button>
                  ))}
                </div>
              )}
              {!opp && (
                <div className={styles.suggestionRow}>
                  {[
                    'Give me a pipeline health summary',
                    'Which opportunities are stalling?',
                    'What needs attention this week?',
                    'Show me contracts expiring soon',
                  ].map((s) => (
                    <button key={s} className={styles.suggestion} disabled={loading}
                      onClick={() => { send(s) }}>
                      {s}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {messages.map((m, i) => (
            <div key={i} className={`${styles.message} ${m.role === 'user' ? styles.user : styles.assistant}`}>
              {m.role === 'assistant' && (
                <div className={styles.assistantIcon}>✦</div>
              )}
              <div className={styles.bubble}>
                {m.role === 'assistant'
                  ? <>
                      <MarkdownText content={m.content} />
                      {m.model && <div className="text-xs text-muted" style={{ marginTop: 7 }}>via {AI_MODELS.find((model) => model.id === m.model)?.label || m.model}</div>}
                    </>
                  : <p className={styles.messageText}>{m.content}</p>
                }
              </div>
            </div>
          ))}

          {loading && (
            <div className={`${styles.message} ${styles.assistant}`}>
              <div className={styles.assistantIcon}>✦</div>
              <div className={styles.bubble}>
                {toolActivity && (
                  <div className="text-xs text-muted" style={{ marginBottom: 6 }}>{toolActivity}</div>
                )}
                <div className={styles.typingDots}>
                  <span className={styles.dot} />
                  <span className={styles.dot} />
                  <span className={styles.dot} />
                </div>
              </div>
            </div>
          )}

          {error && (
            <div className={styles.errorMsg}>{error}</div>
          )}

          <div ref={bottomRef} />
        </div>

        {/* ── Input area ── */}
        <div className={styles.inputArea}>
          <div className={styles.inputRow}>
            <textarea
              ref={inputRef}
              autoFocus
              className={styles.input}
              placeholder={opp ? `Ask about ${opp[C_TITLE]}…` : 'Ask anything about your pipeline…'}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              rows={1}
            />
            {loading && (
              <button className={styles.stopBtn} onClick={cancel} aria-label="Stop AI response">
                Stop
              </button>
            )}
            <button
              className={styles.sendBtn}
              onClick={handleSend}
              disabled={loading || !input.trim()}
              aria-label="Send"
            >
              {loading ? '…' : '↑'}
            </button>
          </div>
          <div className={styles.inputMeta}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span className={styles.hint}>{loading ? 'You can draft your next message while this response finishes' : 'Enter to send · Shift+Enter for new line'}</span>
              <label className={styles.hint} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                Model
                <select
                  value={preferredModel}
                  disabled={loading}
                  onChange={(e) => setPreferredModel(e.target.value)}
                  style={{ font: 'inherit', color: 'var(--gray-700)', border: '0.5px solid var(--gray-200)', borderRadius: 4, background: 'var(--surface)', padding: '2px 4px' }}
                >
                  {AI_MODELS.map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}
                </select>
              </label>
            </div>
            {messages.length > 0 && (
              <button className={styles.clearBtn} onClick={handleStartFresh} disabled={clearAction.isLoading}>
                {clearAction.isLoading ? 'Clearing…' : 'Clear conversation'}
              </button>
            )}
          </div>
        </div>
      </div>
    </>
  )
}

// Keep both export shapes available. App.jsx imports the default component,
// while the named export makes the page resilient to any existing consumers.
export default AIChat
