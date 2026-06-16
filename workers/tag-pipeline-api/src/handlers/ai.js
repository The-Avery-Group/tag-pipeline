/**
 * ai.js — Groq AI proxy with server-side context assembly
 *
 * Receives a question + context from the frontend.
 * Assembles the full prompt server-side (system prompt never exposed to client).
 * Calls Groq API with the assembled messages.
 * Returns { content, model } to the frontend.
 *
 * Expected request body:
 * {
 *   question: string,
 *   promptType: 'pipeline_summary' | 'opportunity_detail' | 'email_draft' | 'capability_statement',
 *   context: {
 *     // pipeline_summary
 *     kpis?: { total, totalValue, open, closed, byPhase, overdueTasks, topOwner },
 *     // opportunity_detail
 *     opportunity?: { title, contractNumber, agency, phase, value, naics, notes, ... },
 *     // email_draft / capability_statement
 *     contact?: { name, title },
 *     recentNotes?: string,
 *     // databank context (injected by Worker when Databank is integrated)
 *     awards?: object[],
 *     news?: string[],
 *   }
 * }
 */

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

const GROQ_BASE = 'https://api.groq.com/openai/v1'

const MODEL_PRIORITY = [
  'llama-3.3-70b-versatile',
  'llama-3.1-8b-instant',
]

// ── Prompt builders ────────────────────────────────────────────────────────

function buildSystemPrompt(promptType) {
  const base = 'You are a concise, professional analyst assistant for a government contracting firm. Be direct and specific. No markdown bullet points unless asked.'

  switch (promptType) {
    case 'pipeline_summary':
      return `${base} Summarize pipeline data in 2-4 plain-English sentences covering overall state, phase concentrations, and urgent items.`
    case 'opportunity_detail':
      return `${base} Answer questions about specific opportunities using the provided data. Reference contract numbers and agencies by name. If award or news data is provided, incorporate it.`
    case 'email_draft':
      return `${base} Draft concise, professional follow-up emails for government contracting. No placeholders — use all provided data.`
    case 'capability_statement':
      return `${base} Write targeted capability statements matching the firm's services to specific opportunities. 3-4 concise paragraphs.`
    default:
      return base
  }
}

function buildUserMessage(promptType, context, question) {
  const parts = []

  if (promptType === 'pipeline_summary' && context.kpis) {
    const k = context.kpis
    parts.push(`Pipeline data:
Total opportunities: ${k.total}
Pipeline value: ${k.totalValue}
Open: ${k.open} | Awarded: ${k.closed}
Phase breakdown: ${JSON.stringify(k.byPhase)}
Overdue tasks: ${k.overdueTasks}
Top assignee: ${k.topOwner}`)
  }

  if (context.opportunity) {
    const o = context.opportunity
    parts.push(`Opportunity:
Title: ${o.title}
Contract #: ${o.contractNumber}
Agency: ${o.agency}
Phase: ${o.phase}
Value: ${o.value}
NAICS: ${o.naics}
Assigned to: ${o.assignedTo}
Notes: ${o.recentNotes || 'None'}`)
  }

  if (context.contact) {
    parts.push(`Contact: ${context.contact.name}${context.contact.title ? `, ${context.contact.title}` : ''}`)
  }

  // Databank award data — injected when available
  if (context.awards && context.awards.length > 0) {
    parts.push(`Recent contract awards (from Databank):
${context.awards.slice(0, 10).map((a) =>
  `- ${a.recipient_name || 'Unknown'} | $${a.award_amount?.toLocaleString() || '?'} | ${a.award_date || '?'}`
).join('\n')}`)
  }

  // News context — injected when available
  if (context.news && context.news.length > 0) {
    parts.push(`Recent relevant news:
${context.news.slice(0, 5).map((n, i) => `${i + 1}. ${n}`).join('\n')}`)
  }

  if (question) parts.push(`Question: ${question}`)

  return parts.join('\n\n')
}

// ── Groq call with model fallback ──────────────────────────────────────────

async function callGroq(messages, apiKey) {
  let lastError = null

  for (const model of MODEL_PRIORITY) {
    try {
      const res = await fetch(`${GROQ_BASE}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ model, max_tokens: 1000, messages }),
      })

      if (res.status === 429 || res.status === 503) {
        lastError = new Error(`Rate limited on ${model}`)
        continue
      }

      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body?.error?.message || `Groq error: ${res.status}`)
      }

      const data = await res.json()
      return {
        content: data.choices?.[0]?.message?.content ?? '',
        model,
      }
    } catch (err) {
      if (!err.message.includes('Rate limited')) throw err
      lastError = err
    }
  }

  throw lastError || new Error('All Groq models failed')
}

// ── Handler ────────────────────────────────────────────────────────────────

export async function handleAIChat(req, env) {
  if (!env.GROQ_API_KEY) {
    return json({ error: 'AI not configured' }, 503)
  }

  let body
  try {
    body = await req.json()
  } catch {
    return json({ error: 'Invalid JSON body' }, 400)
  }

  const { question, promptType = 'pipeline_summary', context = {} } = body

  const messages = [
    { role: 'system', content: buildSystemPrompt(promptType) },
    { role: 'user',   content: buildUserMessage(promptType, context, question) },
  ]

  try {
    const result = await callGroq(messages, env.GROQ_API_KEY)
    return json(result)
  } catch (err) {
    console.error('[AI] Groq call failed:', err)
    return json({ error: err.message }, 502)
  }
}
