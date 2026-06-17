import { useState, useCallback, useEffect, useRef } from 'react'
import { sendAIMessage, getConversationHistory, clearConversation } from '@/services/groqService'

/**
 * useAIChat — manages conversational AI state
 * @param {string} conversationId — unique ID for this conversation thread
 * @param {string} promptType     — 'general' | 'opportunity_detail' etc
 * @param {object} initialContext — context to seed the conversation (opportunity data etc)
 */
export function useAIChat({ conversationId, promptType = 'general', initialContext = {} }) {
  const [messages,  setMessages]  = useState([])   // { role, content }[]
  const [loading,   setLoading]   = useState(false)
  const [error,     setError]     = useState(null)
  const [historyLoaded, setHistoryLoaded] = useState(false)
  const abortRef = useRef(null)

  // Load existing history on mount
  useEffect(() => {
    if (!conversationId) { setHistoryLoaded(true); return }
    getConversationHistory(conversationId).then((history) => {
      // Filter out the seeding exchange (context injection) from display
      const displayable = history.filter((m) => {
        if (m.role === 'user' && m.content.startsWith('Context for this conversation:')) return false
        if (m.role === 'assistant' && m.content.startsWith('Understood. I have reviewed')) return false
        return true
      })
      setMessages(displayable)
      setHistoryLoaded(true)
    })
  }, [conversationId])

  const send = useCallback(async (userMessage) => {
    if (!userMessage.trim() || loading) return

    const newUserMsg = { role: 'user', content: userMessage }
    setMessages((prev) => [...prev, newUserMsg])
    setLoading(true)
    setError(null)

    try {
      const result = await sendAIMessage({
        message: userMessage,
        promptType,
        context: initialContext,
        conversationId,
        startFresh: false,
      })
      setMessages((prev) => [...prev, { role: 'assistant', content: result.content }])
    } catch (err) {
      if (err.name !== 'AbortError') {
        setError('Failed to get response. Please try again.')
        // Remove the user message on error so they can retry
        setMessages((prev) => prev.slice(0, -1))
      }
    } finally {
      setLoading(false)
    }
  }, [loading, promptType, initialContext, conversationId])

  const startFresh = useCallback(async () => {
    if (conversationId) await clearConversation(conversationId)
    setMessages([])
    setError(null)
  }, [conversationId])

  return { messages, loading, error, historyLoaded, send, startFresh }
}