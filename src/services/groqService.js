/**
 * groqService.js
 * All AI calls go through the Cloudflare Worker — no API keys in the browser.
 */

const WORKER_URL = import.meta.env.VITE_API_BASE_URL

// ── Core chat function ─────────────────────────────────────────────────────

/**
 * Send a message to the Worker AI endpoint.
 * Used by both AIPanel (one-shot) and AIChat (conversational).
 */
export async function sendAIMessage({
  message = '',
  promptType = 'general',
  context = {},
  conversationId = null,
  startFresh = false,
} = {}) {
  if (!WORKER_URL) throw new Error('VITE_API_BASE_URL not set')

  const res = await fetch(`${WORKER_URL}/ai/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, promptType, context, conversationId, startFresh }),
  })

  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err.error || `Worker AI error: ${res.status}`)
  }

  return res.json()  // { content, model, conversationId }
}

/**
 * Fetch conversation history from KV.
 */
export async function getConversationHistory(conversationId) {
  if (!WORKER_URL || !conversationId) return []
  const res = await fetch(`${WORKER_URL}/ai/history?conversationId=${encodeURIComponent(conversationId)}`)
  if (!res.ok) return []
  const data = await res.json()
  return data.messages || []
}

/**
 * Clear a conversation from KV.
 */
export async function clearConversation(conversationId) {
  if (!WORKER_URL || !conversationId) return
  await fetch(`${WORKER_URL}/ai/history?conversationId=${encodeURIComponent(conversationId)}`, {
    method: 'DELETE',
  })
}

// ── Context builders ───────────────────────────────────────────────────────

export function buildPipelineSummaryContext(kpis, pipeline = []) {
  const today = new Date(); today.setHours(0, 0, 0, 0)
  const in90 = new Date(today); in90.setDate(in90.getDate() + 90)

  // Stale: early-phase opps with no modification in 7+ days
  // Ranked by: most days stale first, ties broken by value descending
  const staleOpportunities = pipeline
    .filter((o) => {
      const phase = o['TAG Opportunity Phase']
      if (!['Identified', 'Research'].includes(phase)) return false
      const mod = o['Last Modified*']
      if (!mod) return true
      const d = new Date(mod + 'T00:00:00')
      return (today - d) / 86400000 >= 7
    })
    .map((o) => ({
      title:        o['Project Title / Description*'],
      phase:        o['TAG Opportunity Phase'],
      lastModified: o['Last Modified*'],
      value:        parseFloat(String(o['Total Contract Value ($)*'] || '0').replace(/[^0-9.]/g, '')) || 0,
      daysStale:    o['Last Modified*']
        ? Math.floor((today - new Date(o['Last Modified*'] + 'T00:00:00')) / 86400000)
        : 999,
    }))
    .sort((a, b) => b.daysStale - a.daysStale || b.value - a.value)
    .slice(0, 5)

  // Expiring within 90 days
  // Ranked by: soonest expiring first (most urgent)
  const expiringOpportunities = pipeline
    .filter((o) => {
      const d = new Date((o['Contract End Date*'] || '') + 'T00:00:00')
      return !isNaN(d) && d >= today && d <= in90
    })
    .map((o) => ({
      title:   o['Project Title / Description*'],
      endDate: o['Contract End Date*'],
      value:   o['Total Contract Value ($)*'],
      daysLeft: Math.floor((new Date(o['Contract End Date*'] + 'T00:00:00') - today) / 86400000),
    }))
    .sort((a, b) => a.daysLeft - b.daysLeft)
    .slice(0, 5)

  return {
    kpis: {
      total:        kpis.total,
      totalValue:   kpis.totalValueFormatted,
      open:         kpis.open,
      closed:       kpis.closed,
      byPhase:      kpis.byPhase,
      overdueTasks: kpis.overdueCount,
      topOwner:     kpis.topOwner,
    },
    staleOpportunities,
    expiringOpportunities,
  }
}

export function buildOpportunityContext(opportunity, recentNotes = '') {
  return {
    opportunity: {
      title:          opportunity['Project Title / Description*']           || '',
      contractNumber: opportunity['Contract Number / Notice ID']            || '',
      agency:         opportunity['Agency*']                                || '',
      phase:          opportunity['TAG Opportunity Phase']                  || '',
      value:          opportunity['Total Contract Value ($)*']              || '',
      naics:          opportunity['NAICS Code*']                            || '',
      assignedTo:     opportunity['Assigned To*']                           || '',
      rfiSubmissionDate: opportunity['Submission Date (Response Date)*']       || '',
      outlook:        opportunity['Opportunity Outlook']                    || '',
      recentNotes,
    },
  }
}

export function buildEmailDraftContext(opportunity, contact, recentNotes = '') {
  return {
    ...buildOpportunityContext(opportunity, recentNotes),
    contact: contact ? { name: contact.Name, title: contact.Title } : null,
  }
}

export function buildCapabilityStatementContext(opportunity, recentNotes = '') {
  return buildOpportunityContext(opportunity, recentNotes)
}

// ── AIPanel compatibility shims ────────────────────────────────────────────
// AIPanel calls buildPrompt() → passes result to groqChat(messages).
// These shims keep AIPanel working without changes until it's updated.

export async function groqChat(messagesOrPromptType, optionsOrContext = {}, question = '') {
  // Detect legacy call: groqChat(messages[], options)
  if (Array.isArray(messagesOrPromptType)) {
    const messages = messagesOrPromptType
    // Extract user content from last user message to use as the message
    const lastUser = [...messages].reverse().find((m) => m.role === 'user')
    return sendAIMessage({
      message:    lastUser?.content || '',
      promptType: 'general',
      context:    {},
    })
  }
  // New call: groqChat(promptType, context, question)
  return sendAIMessage({
    message:    question,
    promptType: messagesOrPromptType,
    context:    optionsOrContext,
  })
}

export function buildPipelineSummaryPrompt(kpis) {
  // Returns context object — AIPanel will pass this to groqChat
  // which now handles both messages[] and context objects
  return buildPipelineSummaryContext(kpis, [])
}

export function buildEmailDraftPrompt(opportunity, contact) {
  return buildEmailDraftContext(opportunity, contact, opportunity.recentNotes || '')
}

export function buildCapabilityStatementPrompt(opportunity) {
  return buildCapabilityStatementContext(opportunity, opportunity.recentNotes || '')
}
