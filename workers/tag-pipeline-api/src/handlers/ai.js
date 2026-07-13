/**
 * ai.js — Groq AI proxy
 *
 * Handles:
 *   POST /ai/chat    — Send a message, get a response (conversational)
 *   GET  /ai/history — Fetch conversation history from KV
 *   DELETE /ai/history — Clear a conversation from KV
 *
 * Features:
 *   - Capabilities document fetched from SharePoint, cached in KV (30 days)
 *   - Conversation history stored in KV per conversationId (30 days TTL)
 *   - Rich system prompts tailored to GovCon context
 *   - Model fallback chain
 */

const GROQ_BASE  = 'https://api.groq.com/openai/v1'
const CAP_CACHE_KEY  = 'capabilities:tag_capabilities_docx'
const CAP_TTL        = 60 * 60 * 24 * 30   // 30 days
const CONV_TTL       = 60 * 60 * 24 * 30   // 30 days
const MAX_HISTORY    = 12                   // max messages kept per conversation
const MAX_HISTORY_CHARS = 12000              // ~3k tokens, leaves room for tools and responses on free tier
const CAP_CONTEXT_MAX_CHARS = 2500

const MODEL_PRIORITY = [
  'openai/gpt-oss-120b',
  'meta-llama/llama-4-scout-17b-16e-instruct',
  'openai/gpt-oss-20b',
]

// Maximum tool-calling round trips per user turn, so a pathological loop
// (model keeps asking for more tools indefinitely) can't run forever.
const MAX_TOOL_ROUNDS = 5

// ── Tool definitions ─────────────────────────────────────────────────────
// Custom tools are EXECUTED ON THE FRONTEND, not here — the pipeline/tasks/
// contacts data already lives in memory on the client (usePipeline/useTasks/
// useContacts, warmed by dataCache.js) via the user's own delegated Graph
// auth. The Worker only orchestrates: send the tool schemas to Groq, and if
// Groq wants to call one, hand that request back to the frontend instead of
// executing it itself. This avoids needing any new Azure AD app permissions
// for the Worker to read the workbook directly.
//
// browser_search is different — it's a Groq BUILT-IN tool that runs
// entirely server-side inside Groq itself. The Worker never sees an
// intermediate tool_calls step for it; Groq handles the whole search+read
// loop internally and just returns a normal completion.
const CLIENT_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'search_pipeline',
      description: 'Search/filter the opportunity pipeline. Use this to find opportunities matching criteria like phase, agency, outlook, or a free-text search across title/agency/contract number. Returns a list of matching opportunities with key fields.',
      parameters: {
        type: 'object',
        properties: {
          query:   { type: 'string', description: 'Free-text search across title, agency, contract number' },
          phase:   { type: 'string', description: 'Filter by TAG Opportunity Phase (e.g. Identified, Proposal, Contract Awarded)' },
          outlook: { type: 'string', description: 'Filter by Opportunity Outlook (e.g. Expiring, Tracking, New)' },
          agency:  { type: 'string', description: 'Filter by agency name (partial match)' },
          limit:   { type: 'number', description: 'Max results to return, default 20' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_opportunity',
      description: 'Get full details for one specific opportunity by its Contract Number / Notice ID.',
      parameters: {
        type: 'object',
        properties: {
          contractNumber: { type: 'string', description: 'The Contract Number / Notice ID to look up' },
        },
        required: ['contractNumber'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_tasks',
      description: 'Search/filter tasks by status, assignee, overdue state, or associated contract.',
      parameters: {
        type: 'object',
        properties: {
          status:         { type: 'string', description: 'Filter by status: "To Do", "In Progress", or "Done"' },
          assignedTo:     { type: 'string', description: 'Filter by assignee name' },
          overdueOnly:    { type: 'boolean', description: 'If true, only return overdue, non-Done tasks' },
          contractNumber: { type: 'string', description: 'Filter to tasks for a specific contract number' },
          limit:          { type: 'number', description: 'Max results to return, default 20' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_contacts',
      description: 'Search contacts by name, agency, or organization.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Free-text search across name, agency, organization' },
          limit: { type: 'number', description: 'Max results to return, default 20' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_expiring_contracts',
      description: 'Get contracts expiring/ending within a given number of days — useful for recompete and capture planning questions.',
      parameters: {
        type: 'object',
        properties: {
          withinDays: { type: 'number', description: 'Look-ahead window in days, default 180' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_pipeline_metrics',
      description: 'Get overall pipeline KPIs: total opportunities, total value, phase breakdown, overdue task count, top assignee.',
      parameters: { type: 'object', properties: {} },
    },
  },
  // NOTE: a Groq built-in web-search tool was here as { type: 'browser_search' }
  // and it was wrong — Groq's Chat Completions endpoint (what callGroq uses)
  // only accepts tools[].type of "function" or "mcp"; built-in tools like
  // browser_search appear to require the separate (beta) Responses API,
  // which is a bigger surface change than fixing this warrants right now.
  // Removed until that's actually verified working — this was silently
  // breaking every tool-capable request with a 400.
]

// Only the conversational promptTypes get tools — the one-shot AIPanel
// flows (email_draft, capability_statement, pipeline_summary) already get
// precisely-scoped context injected directly for their single specific
// task; giving them a tool-calling round trip would add latency for no
// benefit, since they don't need to explore data, just use what's handed
// to them.
const TOOL_CAPABLE_PROMPT_TYPES = ['general', 'opportunity_detail']

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

// ── KV helpers ─────────────────────────────────────────────────────────────

async function kvGet(env, key) {
  if (!env.CACHE) return null
  return env.CACHE.get(key, 'json')
}

async function kvSet(env, key, value, ttl) {
  if (!env.CACHE) return
  await env.CACHE.put(key, JSON.stringify(value), { expirationTtl: ttl })
}

async function kvDelete(env, key) {
  if (!env.CACHE) return
  await env.CACHE.delete(key)
}

// ── Capabilities document ──────────────────────────────────────────────────

async function getCapabilities(env) {
  // Try KV cache first
  const cached = await kvGet(env, CAP_CACHE_KEY)
  if (cached) return cached

  // Need MS credentials + file ID to fetch from SharePoint
  if (!env.MS_TENANT_ID || !env.MS_CLIENT_ID || !env.MS_CLIENT_SECRET || !env.CAPABILITIES_FILE_ID || !env.DRIVE_ID) {
    return null   // gracefully degrade — just won't have capabilities context
  }

  try {
    // Get app-only token via client credentials flow
    const tokenRes = await fetch(
      `https://login.microsoftonline.com/${env.MS_TENANT_ID}/oauth2/v2.0/token`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type:    'client_credentials',
          client_id:     env.MS_CLIENT_ID,
          client_secret: env.MS_CLIENT_SECRET,
          scope:         'https://graph.microsoft.com/.default',
        }),
      }
    )
    if (!tokenRes.ok) return null
    const { access_token } = await tokenRes.json()

    // Fetch the docx content as plain text via Graph
    const fileRes = await fetch(
      `https://graph.microsoft.com/v1.0/drives/${env.DRIVE_ID}/items/${env.CAPABILITIES_FILE_ID}/content`,
      { headers: { Authorization: `Bearer ${access_token}` } }
    )
    if (!fileRes.ok) return null

    // Graph returns the raw file bytes — extract text content
    // For a .docx we get the raw XML; strip tags to get plain text
    const raw = await fileRes.text()
    const text = raw
      .replace(/<[^>]+>/g, ' ')   // strip XML/HTML tags
      .replace(/\s+/g, ' ')       // collapse whitespace
      .trim()
      .slice(0, CAP_CONTEXT_MAX_CHARS)

    if (text) await kvSet(env, CAP_CACHE_KEY, text, CAP_TTL)
    return text || null
  } catch (err) {
    console.error('[AI] Failed to fetch capabilities:', err)
    return null
  }
}

// ── System prompt builder ──────────────────────────────────────────────────

function buildSystemPrompt(promptType, capabilities) {
  const capSection = capabilities
    ? `\n\nFIRM CAPABILITIES (from TAG_Capabilities.docx):\n${capabilities}`
    : ''

  const base = `You are an expert government contracting analyst and advisor for TAG (The Avery Group), a government contracting firm. You have deep knowledge of the federal acquisition process, GovCon strategy, and business development.${capSection}

CRITICAL RULES:
- Be specific, actionable, and direct. No generic advice.
- Always reference actual data provided to you (opportunity names, contract numbers, agencies, values).
- When you spot issues (stale opportunities, approaching deadlines, missing assignees), name them explicitly.
- Use GovCon terminology correctly (PWIN, capture, BD, RFI, RFP, RFQ, set-aside, NAICS, incumbent, recompete).
- Never say "I'm ready to assist" or give generic openings. Get straight to the analysis.`

  switch (promptType) {
    case 'pipeline_summary':
      return `${base}

YOUR TASK — PIPELINE HEALTH ANALYSIS:
Analyze the pipeline data provided and give a sharp 3-5 sentence executive summary covering:
1. Overall pipeline health (value, phase distribution, win posture)
2. Specific opportunities that are STALE (no activity, forgotten, not progressing)
3. Opportunities approaching submission deadlines that need immediate attention
4. Phase concentration warnings (too many in one phase, bottlenecks)
5. Unassigned or under-resourced high-value opportunities
6. Contracts expiring soon that represent recompete/capture opportunities
7. Any forward momentum concerns — opportunities being added but not advancing

Be specific. Name the opportunities and phases. If something needs attention, say so clearly.`

    case 'opportunity_detail':
      return `${base}

YOUR TASK — OPPORTUNITY ANALYSIS:
You are discussing a specific opportunity with a member of the BD/capture team.
Answer their questions using the opportunity data provided.
If asked about competitive landscape, win probability, or strategy — give your best GovCon analysis.
If award data or news context is provided, incorporate it into your analysis.
Be conversational but sharp. Stay focused on what helps them win this contract.`

    case 'email_draft':
      return `${base}

YOUR TASK — EMAIL DRAFTING:
Draft a professional, concise follow-up email for the opportunity provided.
Use the firm's capabilities and the opportunity details to make it relevant.
No placeholders. Reference the specific agency, contract, and contact.
Keep it under 200 words. Professional but not stiff.`

    case 'capability_statement':
      return `${base}

YOUR TASK — CAPABILITY STATEMENT:
Write a targeted 3-4 paragraph capability statement matching TAG's capabilities to this specific opportunity.
Reference the NAICS code, agency, and contract requirements.
Lead with relevant past performance or core competency.
Close with a differentiator or value proposition specific to this opportunity.`

    case 'general':
    default:
      return `${base}

YOUR TASK — GENERAL GovCon ADVISOR:
You are TAG's internal AI analyst. Answer questions about the pipeline, opportunities, strategy, capture planning, or anything GovCon-related.
Use the context and data provided. Be specific and actionable.
If you don't have enough data to answer confidently, say so and explain what information would help.`
  }
}

// ── Groq call ──────────────────────────────────────────────────────────────

function modelOrder(preferredModel) {
  if (!MODEL_PRIORITY.includes(preferredModel)) return MODEL_PRIORITY
  return [preferredModel, ...MODEL_PRIORITY.filter((model) => model !== preferredModel)]
}

async function callGroq(messages, apiKey, tools = null, preferredModel = null) {
  let lastError = null
  const retryAfterSeconds = []
  for (const model of modelOrder(preferredModel)) {
    try {
      const body = { model, max_tokens: 1000, messages }
      if (tools) { body.tools = tools; body.tool_choice = 'auto' }

      const res = await fetch(`${GROQ_BASE}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
      })
      if (res.status === 429 || res.status === 503) {
        lastError = new Error(res.status === 429 ? `Rate limited on ${model}` : `Temporarily unavailable: ${model}`)
        lastError.status = res.status
        if (res.status === 429) {
          const retryAfter = Number(res.headers.get('retry-after'))
          if (Number.isFinite(retryAfter) && retryAfter > 0) retryAfterSeconds.push(retryAfter)
        }
        continue
      }
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}))
        throw new Error(errBody?.error?.message || `Groq error: ${res.status}`)
      }
      const data = await res.json()
      const choice = data.choices?.[0]
      return {
        content:      choice?.message?.content ?? '',
        toolCalls:    choice?.message?.tool_calls ?? null,
        finishReason: choice?.finish_reason,
        model,
      }
    } catch (err) {
      if (!err.message.includes('Rate limited')) throw err
      lastError = err
    }
  }
  if (lastError?.status === 429) {
    lastError.retryAfterSeconds = retryAfterSeconds.length > 0
      ? Math.min(...retryAfterSeconds)
      : 60
  }
  throw lastError || new Error('All Groq models failed')
}

// ── Context block builder ──────────────────────────────────────────────────

function buildContextBlock(context) {
  if (!context || Object.keys(context).length === 0) return ''
  const parts = []

  if (context.kpis) {
    const k = context.kpis
    parts.push(`PIPELINE DATA:
- Total opportunities: ${k.total} (${k.open} open, ${k.closed} awarded)
- Total pipeline value: ${k.totalValue}
- Phase breakdown: ${Object.entries(k.byPhase || {}).map(([p, c]) => `${p}: ${c}`).join(', ')}
- Overdue tasks: ${k.overdueTasks}
- Top assignee: ${k.topOwner}`)
  }

  if (context.staleOpportunities?.length > 0) {
    parts.push(`STALE OPPORTUNITIES (no activity 7+ days):
${context.staleOpportunities.map((o) => `- ${o.title} | ${o.phase} | Last modified: ${o.lastModified || 'unknown'}`).join('\n')}`)
  }

  if (context.expiringOpportunities?.length > 0) {
    parts.push(`EXPIRING CONTRACTS (within 90 days — recompete/capture opportunities):
${context.expiringOpportunities.map((o) => `- ${o.title} | Expires: ${o.endDate} | Value: ${o.value}`).join('\n')}`)
  }

  if (context.opportunity) {
    const o = context.opportunity
    parts.push(`OPPORTUNITY:
- Title: ${o.title}
- Contract #: ${o.contractNumber}
- Agency: ${o.agency}
- Phase: ${o.phase}
- Value: ${o.value}
- NAICS: ${o.naics}
- Assigned to: ${o.assignedTo || 'Unassigned'}
- Submission date: ${o.submissionDate || 'Unknown'}
- Outlook: ${o.outlook || 'Unknown'}
- Notes: ${o.recentNotes || 'None'}`)
  }

  if (context.contact) {
    parts.push(`CONTACT: ${context.contact.name}${context.contact.title ? `, ${context.contact.title}` : ''}`)
  }

  if (context.awards?.length > 0) {
    parts.push(`RECENT CONTRACT AWARDS (Databank):
${context.awards.slice(0, 10).map((a) =>
  `- ${a.recipient_name || 'Unknown'} | $${a.award_amount?.toLocaleString() || '?'} | ${a.award_date || '?'}`
).join('\n')}`)
  }

  if (context.news?.length > 0) {
    parts.push(`RECENT NEWS:\n${context.news.slice(0, 5).map((n, i) => `${i + 1}. ${n}`).join('\n')}`)
  }

  return parts.join('\n\n')
}

// ── Conversation history ───────────────────────────────────────────────────

function convKey(conversationId) {
  return `conv:${conversationId}`
}

async function getHistory(env, conversationId) {
  return (await kvGet(env, convKey(conversationId))) || []
}

async function saveHistory(env, conversationId, messages) {
  // Bound both turns and approximate input size. A message-count-only limit
  // still lets one large tool result consume the free-tier TPM budget.
  const trimmed = []
  let chars = 0
  for (const message of [...messages].reverse()) {
    const size = JSON.stringify(message).length
    if (trimmed.length > 0 && (trimmed.length >= MAX_HISTORY || chars + size > MAX_HISTORY_CHARS)) break
    trimmed.unshift(message)
    chars += size
  }
  await kvSet(env, convKey(conversationId), trimmed, CONV_TTL)
}

// ── Handlers ───────────────────────────────────────────────────────────────

export async function handleAIChat(req, env) {
  if (!env.GROQ_API_KEY) return json({ error: 'AI not configured' }, 503)

  // Handle sub-routes: GET /ai/history, DELETE /ai/history
  const url = new URL(req.url)
  if (req.method === 'GET') return handleGetHistory(req, env, url)
  if (req.method === 'DELETE') return handleDeleteHistory(req, env, url)

  // POST /ai/chat
  let body
  try { body = await req.json() }
  catch { return json({ error: 'Invalid JSON body' }, 400) }

  const {
    message,
    question,              // legacy compat from one-shot panels
    toolResults,            // present when the frontend is responding to a prior tool_calls request
    toolRound = 0,          // safety-net counter, see MAX_TOOL_ROUNDS below
    promptType = 'general',
    context = {},
    conversationId,
    startFresh = false,
    preferredModel = null,
  } = body

  const userMessage = message || question || ''
  const toolCapable = TOOL_CAPABLE_PROMPT_TYPES.includes(promptType)

  if (!userMessage && !toolResults && promptType !== 'pipeline_summary') {
    return json({ error: 'Missing message' }, 400)
  }

  // Fetch capabilities and existing history in parallel. On a toolResults
  // follow-up we always need history (it holds the pending assistant
  // tool_calls message we're completing), regardless of startFresh.
  const needHistory = conversationId && (!startFresh || toolResults)
  const [capabilities, existingHistory] = await Promise.all([
    getCapabilities(env),
    needHistory ? getHistory(env, conversationId) : Promise.resolve([]),
  ])

  const systemPrompt = buildSystemPrompt(promptType, capabilities)
  const contextBlock = buildContextBlock(context)

  // turnMessages = exactly what's new this turn, on top of existingHistory —
  // tracked explicitly (rather than derived via slicing later) so it's
  // trivially correct to append to history however this call resolves,
  // regardless of which branch below built it.
  let turnMessages = []

  if (toolResults) {
    // Follow-up turn: history already ends with the assistant's tool_calls
    // message (saved the first time we returned type: 'tool_calls') — the
    // only new messages this turn are the results the frontend executed.
    turnMessages = toolResults.map((r) => ({
      role: 'tool', tool_call_id: r.tool_call_id, name: r.name, content: JSON.stringify(r.content),
    }))
  } else {
    if (existingHistory.length === 0 && contextBlock) {
      turnMessages.push({ role: 'user', content: `Context for this conversation:\n\n${contextBlock}` })
      turnMessages.push({ role: 'assistant', content: 'Understood. I have reviewed the pipeline and opportunity data. What would you like to discuss?' })
    }
    const finalUserMessage = promptType === 'pipeline_summary' && !userMessage
      ? `Analyze the pipeline data above and give me an executive summary highlighting health, risks, stale opportunities, upcoming deadlines, and any items that need immediate attention.`
      : userMessage
    turnMessages.push({ role: 'user', content: finalUserMessage })
  }

  const messages = [{ role: 'system', content: systemPrompt }, ...existingHistory, ...turnMessages]

  // Past the safety-net round cap — force a text answer instead of yet
  // another tool call, so a pathological loop can't run forever.
  const forceNoTools = toolCapable && toolRound >= MAX_TOOL_ROUNDS
  const toolsForThisCall = toolCapable && !forceNoTools ? CLIENT_TOOLS : null

  try {
    const result = await callGroq(messages, env.GROQ_API_KEY, toolsForThisCall, preferredModel)
    const historyBase = [...existingHistory, ...turnMessages]

    if (result.toolCalls?.length > 0) {
      // Groq wants to call one or more CUSTOM (client-executed) tools —
      // browser_search wouldn't show up here, Groq resolves that internally
      // and just returns a normal completion. Persist the assistant's own
      // tool_calls message so the follow-up request can reconstruct the
      // conversation correctly, and hand the requests to the frontend.
      if (conversationId) {
        const assistantMsg = { role: 'assistant', content: result.content || null, tool_calls: result.toolCalls }
        await saveHistory(env, conversationId, [...historyBase, assistantMsg])
      }
      return json({
        type: 'tool_calls',
        toolCalls: result.toolCalls.map((tc) => ({
          id: tc.id,
          name: tc.function.name,
          arguments: JSON.parse(tc.function.arguments || '{}'),
        })),
        conversationId,
      })
    }

    // Normal completion — save full history and return the final answer.
    if (conversationId) {
      await saveHistory(env, conversationId, [...historyBase, { role: 'assistant', content: result.content }])
    }

    return json({ type: 'final', content: result.content, model: result.model, conversationId })
  } catch (err) {
    console.error('[AI] Groq call failed:', err)
    return json(
      { error: err.message, retryAfterSeconds: err.retryAfterSeconds || undefined },
      err.status === 429 ? 429 : 502
    )
  }
}

async function handleGetHistory(req, env, url) {
  const conversationId = url.searchParams.get('conversationId')
  if (!conversationId) return json({ error: 'Missing conversationId' }, 400)
  const history = await getHistory(env, conversationId)
  return json({ conversationId, messages: history })
}

async function handleDeleteHistory(req, env, url) {
  const conversationId = url.searchParams.get('conversationId')
  if (!conversationId) return json({ error: 'Missing conversationId' }, 400)
  await kvDelete(env, convKey(conversationId))
  return json({ ok: true, conversationId })
}
