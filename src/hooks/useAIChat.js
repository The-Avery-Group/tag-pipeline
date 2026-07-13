import { useState, useCallback, useEffect, useRef } from 'react'
import { sendAIMessage, getConversationHistory, clearConversation, executeClientTool } from '@/services/groqService'

// Mirrors the Worker's own MAX_TOOL_ROUNDS safety net — belt and suspenders
// against a pathological loop where the model keeps asking for more tools.
const MAX_TOOL_ROUNDS = 5
const MAX_RATE_LIMIT_RETRIES = 1
const MAX_RATE_LIMIT_WAIT_SECONDS = 60

function waitWithAbort(ms, signal) {
  return new Promise((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener('abort', onAbort)
    const timer = setTimeout(() => {
      cleanup()
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      cleanup()
      reject(new DOMException('Request cancelled', 'AbortError'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

// Friendly status labels shown while a tool call is being executed, so the
// user sees "Searching your pipeline…" instead of a longer silent spinner
// during the extra round trip(s) tool calling adds.
const TOOL_ACTIVITY_LABELS = {
  search_pipeline:        'Searching your pipeline…',
  get_opportunity:        'Looking up that opportunity…',
  get_opportunity_notes:  'Reviewing opportunity notes…',
  get_opportunity_tasks:  'Checking linked tasks…',
  get_opportunity_contacts: 'Checking linked contacts…',
  search_notes:           'Searching CRM notes…',
  search_tasks:           'Checking tasks…',
  search_contacts:        'Searching contacts…',
  get_expiring_contracts: 'Checking expiring contracts…',
  get_pipeline_metrics:   'Pulling pipeline metrics…',
}

/**
 * useAIChat — manages conversational AI state, including the client-side
 * half of tool calling: when the Worker/Groq wants to call a custom tool
 * (search_pipeline, get_opportunity, etc.), this hook executes it locally
 * against already-loaded data and sends the result back, looping until a
 * final answer comes back. (Groq's built-in browser_search tool resolves
 * entirely server-side and never surfaces here as a round trip.)
 *
 * @param {string} conversationId — unique ID for this conversation thread
 * @param {string} promptType     — 'general' | 'opportunity_detail' etc
 * @param {object} initialContext — context to seed the conversation (opportunity data etc)
 * @param {object} data           — { pipeline, tasks, contacts } for tool execution
 */
export function useAIChat({ conversationId, promptType = 'general', initialContext = {}, data = {}, preferredModel = null }) {
  const [messages,  setMessages]  = useState([])   // { role, content }[]
  const [loading,   setLoading]   = useState(false)
  const [error,     setError]     = useState(null)
  const [historyLoaded, setHistoryLoaded] = useState(false)
  const [toolActivity, setToolActivity] = useState(null)   // friendly label while a tool call is in flight
  const abortRef = useRef(null)

  const sendWithRateLimitRetry = useCallback(async (payload, signal) => {
    let retries = 0
    while (true) {
      try {
        return await sendAIMessage({ ...payload, preferredModel, signal })
      } catch (err) {
        if (err.status !== 429 || retries >= MAX_RATE_LIMIT_RETRIES) throw err
        retries++
        const seconds = Math.min(
          Math.max(Math.ceil(err.retryAfterSeconds || MAX_RATE_LIMIT_WAIT_SECONDS), 1),
          MAX_RATE_LIMIT_WAIT_SECONDS
        )
        setToolActivity(`Groq is rate-limited — retrying in ${seconds}s…`)
        await waitWithAbort(seconds * 1000, signal)
      }
    }
  }, [preferredModel])

  // Keep the latest data available to the tool loop without needing to
  // recreate send()/runToolLoop() every time pipeline/tasks/contacts update
  // from the background poll mid-conversation.
  const dataRef = useRef(data)
  useEffect(() => { dataRef.current = data }, [data])

  // Load existing history on mount
  useEffect(() => {
    if (!conversationId) { setHistoryLoaded(true); return }
    getConversationHistory(conversationId).then((history) => {
      // Filter out internal plumbing (context seeding, tool_calls messages,
      // tool results) — only real conversational turns get displayed.
      const displayable = history.filter((m) => {
        if (m.role === 'user' && m.content?.startsWith('Context for this conversation:')) return false
        if (m.role === 'assistant' && m.content?.startsWith('Understood. I have reviewed')) return false
        if (m.role === 'tool') return false
        if (m.role === 'assistant' && !m.content) return false   // tool_calls-only, no displayable text
        return true
      })
      setMessages(displayable)
      setHistoryLoaded(true)
    })
  }, [conversationId])

  // Drives the tool-calling loop: given a response from the Worker, keep
  // executing tool calls and sending results back until a final answer
  // comes back (or the round cap is hit, mirroring the Worker's own cap).
  const runToolLoop = useCallback(async (initialResult, signal) => {
    let result = initialResult
    let round = 0
    while (result.type === 'tool_calls' && round < MAX_TOOL_ROUNDS) {
      round++
      const label = TOOL_ACTIVITY_LABELS[result.toolCalls[0]?.name] || 'Checking your data…'
      setToolActivity(label)

      const toolResults = result.toolCalls.map((call) => ({
        tool_call_id: call.id,
        name: call.name,
        content: executeClientTool(call.name, call.arguments, dataRef.current),
      }))

      result = await sendWithRateLimitRetry({
        promptType, context: initialContext,
        conversationId: result.conversationId,
        toolResults, toolRound: round,
      }, signal)
    }
    setToolActivity(null)
    return result
  }, [promptType, initialContext, sendWithRateLimitRetry])

  const send = useCallback(async (userMessage) => {
    if (!userMessage.trim() || loading) return

    const newUserMsg = { role: 'user', content: userMessage }
    setMessages((prev) => [...prev, newUserMsg])
    setLoading(true)
    setError(null)

    const controller = new AbortController()
    abortRef.current = controller

    try {
      let result = await sendWithRateLimitRetry({
        message: userMessage,
        promptType,
        context: initialContext,
        conversationId,
        startFresh: false,
      }, controller.signal)
      result = await runToolLoop(result, controller.signal)
      setMessages((prev) => [...prev, { role: 'assistant', content: result.content, model: result.model }])
    } catch (err) {
      if (err.name === 'AbortError') {
        setMessages((prev) => [...prev, { role: 'assistant', content: 'Response stopped.' }])
      } else {
        setError('Failed to get response. Please try again.')
        // Remove the user message on error so they can retry
        setMessages((prev) => prev.slice(0, -1))
      }
    } finally {
      if (abortRef.current === controller) abortRef.current = null
      setLoading(false)
      setToolActivity(null)
    }
  }, [loading, promptType, initialContext, conversationId, runToolLoop, sendWithRateLimitRetry])

  const cancel = useCallback(() => {
    abortRef.current?.abort()
  }, [])

  const startFresh = useCallback(async () => {
    if (conversationId) await clearConversation(conversationId)
    setMessages([])
    setError(null)
  }, [conversationId])

  return { messages, loading, error, historyLoaded, send, startFresh, toolActivity, cancel }
}
