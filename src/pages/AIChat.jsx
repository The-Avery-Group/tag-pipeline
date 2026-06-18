import { useState, useEffect, useRef, useMemo } from 'react'
import { useSearchParams, useNavigate } from 'react-router-dom'
import { usePipeline } from '@/hooks/usePipeline'
import { useTasks } from '@/hooks/useTasks'
import { useAIChat } from '@/hooks/useAIChat'
import Topbar from '@/components/Layout/Topbar'
import MarkdownText from '@/components/AI/MarkdownText'
import { buildPipelineSummaryContext, buildOpportunityContext } from '@/services/groqService'
import { computeKPIs } from '@/utils/kpiHelpers'
import styles from './AIChat.module.css'

const C_CN    = 'Contract Number / Notice ID'
const C_TITLE = 'Project Title / Description*'

// Generate a stable conversation ID
function makeConvId(base) {
  return `conv_${base}_${new Date().toISOString().split('T')[0]}`
}

export default function AIChat({ toast }) {
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const { pipeline } = usePipeline()
  const { tasks } = useTasks()

  const oppCN      = searchParams.get('opportunity')
  const freshParam = searchParams.get('fresh') === '1'

  // Find opportunity if opened from OpportunityDetail
  const opp = useMemo(
    () => oppCN ? pipeline.find((o) => o[C_CN] === oppCN) : null,
    [pipeline, oppCN]
  )

  const promptType = opp ? 'opportunity_detail' : 'general'

  // Build context — always include pipeline summary for general chat
  const context = useMemo(() => {
    if (opp) {
      // Opportunity-specific: include the opp details + pipeline summary for broader questions
      return {
        ...buildOpportunityContext(opp, ''),
        ...buildPipelineSummaryContext(computeKPIs(pipeline, tasks), pipeline),
      }
    }
    // General chat: full pipeline context so AI can answer any operational question
    return buildPipelineSummaryContext(computeKPIs(pipeline, tasks), pipeline)
  }, [opp, pipeline, tasks])

  const convId = opp
    ? makeConvId(oppCN.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 40))
    : makeConvId('general')

  const { messages, loading, error, historyLoaded, send, startFresh } = useAIChat({
    conversationId: convId,
    promptType,
    initialContext: context,
  })

  const [input, setInput] = useState('')
  const bottomRef = useRef(null)
  const inputRef  = useRef(null)

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
    if (!input.trim()) return
    send(input.trim())
    setInput('')
    inputRef.current?.focus()
  }

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  const handleStartFresh = async () => {
    await startFresh()
    toast?.success('Conversation cleared')
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
                    <button key={s} className={styles.suggestion}
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
                    <button key={s} className={styles.suggestion}
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
                  ? <MarkdownText content={m.content} />
                  : <p className={styles.messageText}>{m.content}</p>
                }
              </div>
            </div>
          ))}

          {loading && (
            <div className={`${styles.message} ${styles.assistant}`}>
              <div className={styles.assistantIcon}>✦</div>
              <div className={styles.bubble}>
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
              className={styles.input}
              placeholder={opp ? `Ask about ${opp[C_TITLE]}…` : 'Ask anything about your pipeline…'}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              rows={1}
              disabled={loading}
            />
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
            <span className={styles.hint}>Enter to send · Shift+Enter for new line</span>
            {messages.length > 0 && (
              <button className={styles.clearBtn} onClick={handleStartFresh}>
                Clear conversation
              </button>
            )}
          </div>
        </div>
      </div>
    </>
  )
}
