/**
 * groqService.js
 * Calls Groq's OpenAI-compatible API with automatic model fallback.
 * Priority: openai/gpt-oss-120b → openai/gpt-oss-20b → llama-3.3-70b-versatile → llama-3.1-8b-instant
 */

const GROQ_BASE_URL = 'https://api.groq.com/openai/v1'
const API_KEY = import.meta.env.VITE_GROQ_API_KEY

const MODEL_PRIORITY = [
  'openai/gpt-oss-120b',
  'openai/gpt-oss-20b',
  'llama-3.3-70b-versatile',
  'llama-3.1-8b-instant',
]

/**
 * Send a chat completion request to Groq with automatic fallback.
 * @param {Array} messages  - OpenAI-format messages array
 * @param {Object} options  - { modelOverride, maxTokens, signal }
 * @returns {{ content: string, model: string }}
 */
export async function groqChat(messages, options = {}) {
  const { modelOverride, maxTokens = 1000, signal } = options
  const models = modelOverride ? [modelOverride] : MODEL_PRIORITY

  let lastError = null
  for (const model of models) {
    try {
      const res = await fetch(`${GROQ_BASE_URL}/chat/completions`, {
        method: 'POST',
        signal,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${API_KEY}`,
        },
        body: JSON.stringify({
          model,
          max_tokens: maxTokens,
          messages,
        }),
      })

      if (res.status === 429 || res.status === 503) {
        const body = await res.json().catch(() => ({}))
        lastError = new Error(body?.error?.message || `Rate limited on ${model}`)
        continue // try next model
      }

      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body?.error?.message || `Groq error: ${res.status}`)
      }

      const data = await res.json()
      const content = data.choices?.[0]?.message?.content ?? ''
      return { content, model }
    } catch (err) {
      if (err.name === 'AbortError') throw err
      lastError = err
      // Network errors or non-rate-limit errors — don't fallback, rethrow
      if (!err.message.includes('Rate limited') && err.message !== `Rate limited on ${model}`) {
        throw err
      }
    }
  }

  throw lastError || new Error('All Groq models failed')
}

/**
 * Build a pipeline summary prompt from KPI data.
 */
export function buildPipelineSummaryPrompt(kpis) {
  return [
    {
      role: 'system',
      content:
        'You are a concise business analyst assistant. Write plain, professional summaries in 2–4 sentences. No bullet points. No markdown.',
    },
    {
      role: 'user',
      content: `Summarize the current state of this government contracting pipeline:
Total active opportunities: ${kpis.total}
Total pipeline value: ${kpis.totalValue}
Open opportunities: ${kpis.open}
Closed opportunities: ${kpis.closed}
Phase breakdown: ${JSON.stringify(kpis.byPhase)}
Overdue tasks: ${kpis.overdueTasks}
Top owner by deal count: ${kpis.topOwner}

Write a 2–4 sentence plain-English summary covering the overall pipeline state, any phase concentrations, and any urgent items.`,
    },
  ]
}

/**
 * Build a follow-up email draft prompt.
 */
export function buildEmailDraftPrompt(opportunity, contact) {
  return [
    {
      role: 'system',
      content:
        'You are a professional proposal writer for a government contracting firm. Draft concise, professional follow-up emails. No placeholders — use the data provided.',
    },
    {
      role: 'user',
      content: `Draft a follow-up email for this opportunity:
Opportunity: ${opportunity.ContractTitle}
Agency: ${opportunity.Agency}
Phase: ${opportunity.Phase}
Contract #: ${opportunity.ContractNumber}
Contact name: ${contact?.Name || 'the contracting officer'}
Contact title: ${contact?.Title || ''}
Recent notes: ${opportunity.recentNotes || 'None'}

Write a professional, brief follow-up email from our team to the contact.`,
    },
  ]
}

/**
 * Build a capability statement prompt.
 */
export function buildCapabilityStatementPrompt(opportunity) {
  return [
    {
      role: 'system',
      content:
        'You are a proposal writer for a government contracting firm. Write targeted capability statements that match the firm\'s services to a specific opportunity. Keep it to 3–4 concise paragraphs.',
    },
    {
      role: 'user',
      content: `Write a capability statement for this opportunity:
Opportunity: ${opportunity.ContractTitle}
Agency: ${opportunity.Agency}
NAICS: ${opportunity.NAICS}
Contract #: ${opportunity.ContractNumber}
Solicitation #: ${opportunity.SolicitationNumber || 'TBD'}
Notes: ${opportunity.recentNotes || 'None'}`,
    },
  ]
}
