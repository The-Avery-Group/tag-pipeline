/**
 * groqService.js
 * Calls the Cloudflare Worker AI endpoint — Groq API key stays server-side.
 * The Worker handles model selection, fallback, and prompt assembly.
 */

const WORKER_URL = import.meta.env.VITE_API_BASE_URL

/**
 * Send a chat request to the Worker AI endpoint.
 * @param {string} promptType — 'pipeline_summary' | 'opportunity_detail' | 'email_draft' | 'capability_statement'
 * @param {object} context   — Data context (kpis, opportunity, contact, etc.)
 * @param {string} question  — Optional user question (for opportunity_detail)
 * @returns {{ content: string, model: string }}
 */
export async function groqChat(promptType, context = {}, question = '') {
  if (!WORKER_URL) {
    throw new Error('VITE_API_BASE_URL not set — Worker URL missing')
  }

  const res = await fetch(`${WORKER_URL}/ai/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ promptType, context, question }),
  })

  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err.error || `Worker AI error: ${res.status}`)
  }

  return res.json()   // { content, model }
}

// ── Context builders — called by components before groqChat ───────────────
// These stay in the frontend since they assemble data the frontend already has.
// The Worker receives the assembled context, not raw pipeline data.

export function buildPipelineSummaryContext(kpis) {
  return {
    kpis: {
      total:          kpis.total,
      totalValue:     kpis.totalValueFormatted,
      open:           kpis.open,
      closed:         kpis.closed,
      byPhase:        kpis.byPhase,
      overdueTasks:   kpis.overdueCount,
      topOwner:       kpis.topOwner,
    },
  }
}

export function buildOpportunityContext(opportunity, recentNotes) {
  return {
    opportunity: {
      title:          opportunity['Project Title / Description*']           || '',
      contractNumber: opportunity['Contract Number / Notice ID']            || '',
      agency:         opportunity['Agency*']                                || '',
      phase:          opportunity['TAG Opportunity Phase']                  || '',
      value:          opportunity['Total Contract Value ($)*']              || '',
      naics:          opportunity['NAICS Code*']                            || '',
      assignedTo:     opportunity['Assigned To*']                           || '',
      recentNotes:    recentNotes || '',
    },
  }
}

export function buildEmailDraftContext(opportunity, contact, recentNotes) {
  return {
    ...buildOpportunityContext(opportunity, recentNotes),
    contact: contact
      ? { name: contact.Name, title: contact.Title }
      : null,
  }
}

export function buildCapabilityStatementContext(opportunity, recentNotes) {
  return buildOpportunityContext(opportunity, recentNotes)
}

// ── Legacy compat — keep buildPipelineSummaryPrompt so AIPanel still works ──
// AIPanel calls buildPrompt() which returns messages[]. We'll keep this shim
// until AIPanel is updated to use the new Worker-based approach.
export function buildPipelineSummaryPrompt(kpis) {
  console.warn('[groqService] buildPipelineSummaryPrompt is deprecated — update AIPanel to use groqChat()')
  return [
    { role: 'system', content: 'You are a concise business analyst. Write plain 2-4 sentence summaries.' },
    { role: 'user',   content: `Pipeline: ${JSON.stringify(kpis)}` },
  ]
}

// ── AIPanel compatibility shims ───────────────────────────────────────────
// AIPanel expects buildPrompt() to return an array of messages.
// These wrappers maintain that contract while using the new context structure.

export function buildEmailDraftPrompt(opportunity, contact) {
  const ctx = buildEmailDraftContext(opportunity, contact, opportunity.recentNotes || '')
  return [
    { role: 'system', content: 'You are a professional proposal writer for a government contracting firm. Draft concise, professional follow-up emails. No placeholders — use the data provided.' },
    { role: 'user',   content: `Draft a follow-up email for this opportunity:\n${JSON.stringify(ctx)}` },
  ]
}

export function buildCapabilityStatementPrompt(opportunity) {
  const ctx = buildCapabilityStatementContext(opportunity, opportunity.recentNotes || '')
  return [
    { role: 'system', content: "You are a proposal writer for a government contracting firm. Write targeted capability statements. Keep it to 3-4 concise paragraphs." },
    { role: 'user',   content: `Write a capability statement for:\n${JSON.stringify(ctx)}` },
  ]
}
