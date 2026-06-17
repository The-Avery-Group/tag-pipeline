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
const MAX_HISTORY    = 20                   // max messages kept per conversation

const MODEL_PRIORITY = [
  'openai/gpt-oss-120b',
  'llama-3.3-70b-versatile',
  'openai/gpt-oss-20b',
  'llama-3.1-8b-instant',
]

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
      .slice(0, 4000)              // cap at 4000 chars to stay within context limits

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

async function callGroq(messages, apiKey) {
  let lastError = null
  for (const model of MODEL_PRIORITY) {
    try {
      const res = await fetch(`${GROQ_BASE}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
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
      return { content: data.choices?.[0]?.message?.content ?? '', model }
    } catch (err) {
      if (!err.message.includes('Rate limited')) throw err
      lastError = err
    }
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

  if (context.upcomingDeadlines?.length > 0) {
    parts.push(`UPCOMING SUBMISSION DEADLINES:
${context.upcomingDeadlines.map((o) => `- ${o.title} | Due: ${o.submDate} | Phase: ${o.phase}`).join('\n')}`)
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
  // Keep only last MAX_HISTORY messages to avoid context overflow
  const trimmed = messages.slice(-MAX_HISTORY)
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
    promptType = 'general',
    context = {},
    conversationId,
    startFresh = false,
  } = body

  const userMessage = message || question || ''
  if (!userMessage && promptType !== 'pipeline_summary') {
    return json({ error: 'Missing message' }, 400)
  }

  // Fetch capabilities and existing history in parallel
  const [capabilities, existingHistory] = await Promise.all([
    getCapabilities(env),
    conversationId && !startFresh ? getHistory(env, conversationId) : Promise.resolve([]),
  ])

  // Build system prompt
  const systemPrompt = buildSystemPrompt(promptType, capabilities)

  // Build context block (injected as first user message if history is empty)
  const contextBlock = buildContextBlock(context)

  // Assemble messages array
  let messages = [{ role: 'system', content: systemPrompt }]

  if (existingHistory.length > 0) {
    // Resume conversation — inject history
    messages = [...messages, ...existingHistory]
  } else if (contextBlock) {
    // New conversation with context — seed with context as first exchange
    messages.push({ role: 'user', content: `Context for this conversation:\n\n${contextBlock}` })
    messages.push({ role: 'assistant', content: 'Understood. I have reviewed the pipeline and opportunity data. What would you like to discuss?' })
  }

  // Add the current user message (for pipeline_summary, synthesize a prompt)
  const finalUserMessage = promptType === 'pipeline_summary' && !userMessage
    ? `Analyze the pipeline data above and give me an executive summary highlighting health, risks, stale opportunities, upcoming deadlines, and any items that need immediate attention.`
    : userMessage

  messages.push({ role: 'user', content: finalUserMessage })

  try {
    const result = await callGroq(messages, env.GROQ_API_KEY)

    // Save updated history if conversationId provided
    if (conversationId) {
      const historyToSave = [
        ...existingHistory,
        { role: 'user',      content: finalUserMessage },
        { role: 'assistant', content: result.content },
      ]
      await saveHistory(env, conversationId, historyToSave)
    }

    return json({ ...result, conversationId })
  } catch (err) {
    console.error('[AI] Groq call failed:', err)
    return json({ error: err.message }, 502)
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
