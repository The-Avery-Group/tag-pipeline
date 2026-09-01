/**
 * groqService.js
 * All AI calls go through the Cloudflare Worker — no API keys in the browser.
 */

import { WORKER_URL, workerFetch } from '@/services/workerClient'
import { createCrmRelationshipQuery, queryCrmRelationships } from '@/services/crmRelationshipQuery'

export const AI_MODELS = [
  { id: 'openai/gpt-oss-120b', label: 'GPT-OSS 120B', description: 'Best strategy and reasoning' },
  { id: 'qwen/qwen3.6-27b', label: 'Qwen 3.6 27B', description: 'Long-context reasoning and tool use' },
  { id: 'openai/gpt-oss-20b', label: 'GPT-OSS 20B', description: 'Fast fallback for focused requests' },
]

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
  toolResults = null,   // present when responding to a prior 'tool_calls' response
  toolRound = 0,         // safety-net counter, mirrors MAX_TOOL_ROUNDS on the Worker
  preferredModel = null,
  signal = undefined,
} = {}) {
  if (!WORKER_URL) throw new Error('VITE_API_BASE_URL not set')

  const res = await workerFetch('/ai/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, promptType, context, conversationId, startFresh, toolResults, toolRound, preferredModel }),
    signal,
  })

  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    const error = new Error(err.error || `Worker AI error: ${res.status}`)
    error.status = res.status
    error.retryAfterSeconds = Number(err.retryAfterSeconds) || 0
    throw error
  }

  // Either { type: 'final', content, model, conversationId }
  //      or { type: 'tool_calls', toolCalls: [{ id, name, arguments }], conversationId }
  return res.json()
}

/**
 * Fetch conversation history from KV.
 */
export async function getConversationHistory(conversationId) {
  if (!WORKER_URL || !conversationId) return []
  const res = await workerFetch(`/ai/history?conversationId=${encodeURIComponent(conversationId)}`)
  if (!res.ok) return []
  const data = await res.json()
  return data.messages || []
}

/**
 * Clear a conversation from KV.
 */
export async function clearConversation(conversationId) {
  if (!WORKER_URL || !conversationId) return
  await workerFetch(`/ai/history?conversationId=${encodeURIComponent(conversationId)}`, {
    method: 'DELETE',
  })
}

// ── Client-side tool executors ─────────────────────────────────────────────
// Implements the CUSTOM tools Groq can call (see CLIENT_TOOLS in the
// Worker's ai.js) against data already loaded in memory — pipeline/tasks/
// contacts are already warmed by dataCache.js via usePipeline/useTasks/
// useContacts, so these run instantly with no extra Graph API call and no
// new Azure AD permissions. (Groq's built-in browser_search tool is
// different — it never reaches here, Groq resolves it entirely server-side.)

const C_TITLE    = 'Project Title / Description*'
const C_CN       = 'Contract Number / Notice ID'
const C_AGENCY   = 'Agency*'
const C_PHASE    = 'TAG Opportunity Phase'
const C_OUTLOOK  = 'Opportunity Outlook'
const C_VALUE    = 'Total Contract Value ($)*'
const C_END      = 'Contract End Date*'
const C_ASSIGNEE = 'Assigned To*'
const C_DEPARTMENT = 'Department*'
const C_OFFICE   = 'Office*'
const C_ACTIVITY = 'TAG Pipeline Activity Phase'
const C_SUBMISSION = 'Submission Date (Response Date)*'
const C_POC      = 'Contracting Officer / Specialist (POC)*'
const C_SET_ASIDE = 'Set- Aside*'
const C_PRIORITY = 'Priority'

function summarizeOpportunity(o) {
  return {
    contractNumber: o[C_CN],
    title:          o[C_TITLE],
    agency:         o[C_AGENCY],
    phase:          o[C_PHASE],
    outlook:        o[C_OUTLOOK],
    value:          o[C_VALUE],
    endDate:        o[C_END],
    assignedTo:     o[C_ASSIGNEE],
    department:     o[C_DEPARTMENT],
    office:          o[C_OFFICE],
    activityPhase:  o[C_ACTIVITY],
    submissionDate: o[C_SUBMISSION],
    pointOfContact: o[C_POC],
    setAside:       o[C_SET_ASIDE],
    priority:       o[C_PRIORITY],
  }
}

function summarizeTask(t) {
  return {
    title: t.Title, status: t.Status, priority: t.Priority, dueDate: t.DueDate,
    assignedTo: t.AssignedTo, contractNumber: t.ContractNumber, contractTitle: t.ContractTitle,
  }
}

function isSystemNote(note) {
  return String(note.NoteText || '').startsWith('[TAG_RELATED_OPPORTUNITY]')
}

function recentNotesForContract(notes, contractNumber, limit = 8) {
  return notes
    .filter((note) => note.ContractNumber === contractNumber && !isSystemNote(note))
    .sort((a, b) => new Date(b.Date || 0) - new Date(a.Date || 0))
    .slice(0, limit)
    .map((note) => ({
      date: note.Date,
      author: note.Author,
      text: String(note.NoteText || '').slice(0, 600),
    }))
}

function isOverdueTask(t) {
  if (t.Status === 'Done' || !t.DueDate) return false
  const today = new Date(); today.setHours(0, 0, 0, 0)
  const d = new Date(t.DueDate + 'T00:00:00')
  return !isNaN(d.getTime()) && d < today
}

/**
 * Executes one client-side tool call against already-loaded data.
 * @param name - tool function name, matching CLIENT_TOOLS in ai.js
 * @param args - parsed arguments object from the model's tool call
 * @param data - { pipeline, tasks, contacts } — the in-memory arrays
 */
export function executeClientTool(name, args = {}, data = {}) {
  const { pipeline = [], tasks = [], contacts = [], notes = [] } = data
  const relationshipQuery = createCrmRelationshipQuery(data)

  switch (name) {
    case 'search_pipeline': {
      if (data.readiness?.pipeline === false) {
        return { status: 'data_unavailable', dataReady: false, unavailableTables: ['pipeline'], message: 'Pipeline data is still loading or unavailable.' }
      }
      let rows = pipeline
      if (args.query) {
        const q = args.query.toLowerCase()
        rows = rows.filter((o) =>
          [o[C_TITLE], o[C_CN], o[C_AGENCY], o[C_POC], o[C_DEPARTMENT], o[C_OFFICE]].some((v) => v && String(v).toLowerCase().includes(q))
        )
      }
      if (args.phase)   rows = rows.filter((o) => o[C_PHASE] === args.phase)
      if (args.outlook) rows = rows.filter((o) => o[C_OUTLOOK] === args.outlook)
      if (args.agency) {
        const a = args.agency.toLowerCase()
        rows = rows.filter((o) => String(o[C_AGENCY] || '').toLowerCase().includes(a))
      }
      const limit = Math.min(args.limit || 5, 8)
      return { count: rows.length, opportunities: rows.slice(0, limit).map(summarizeOpportunity) }
    }

    case 'get_opportunity': {
      const match = pipeline.find((o) => o[C_CN] === args.contractNumber)
      if (!match) return { found: false, message: `No opportunity found with contract number ${args.contractNumber}` }
      return { found: true, opportunity: summarizeOpportunity(match) }
    }

    case 'get_opportunity_notes': {
      const limit = Math.min(args.limit || 8, 12)
      return {
        contractNumber: args.contractNumber,
        count: notes.filter((note) => note.ContractNumber === args.contractNumber && !isSystemNote(note)).length,
        notes: recentNotesForContract(notes, args.contractNumber, limit),
      }
    }

    case 'get_opportunity_tasks': {
      const limit = Math.min(args.limit || 8, 12)
      const matchingTasks = tasks.filter((task) => task.ContractNumber === args.contractNumber)
      return {
        contractNumber: args.contractNumber,
        count: matchingTasks.length,
        tasks: matchingTasks.slice(0, limit).map(summarizeTask),
      }
    }

    case 'get_opportunity_contacts': {
      const opportunity = pipeline.find((o) => o[C_CN] === args.contractNumber)
      if (!opportunity) return { found: false, message: `No opportunity found with contract number ${args.contractNumber}` }
      const pointOfContact = String(opportunity[C_POC] || '').toLowerCase()
      const linked = contacts.filter((contact) => {
        const name = String(contact.Name || '').trim().toLowerCase()
        const email = String(contact.Email || '').trim().toLowerCase()
        return (name.length >= 3 && pointOfContact.includes(name)) || (email && pointOfContact.includes(email))
      })
      return {
        found: true,
        pointOfContact: opportunity[C_POC] || '',
        count: linked.length,
        contacts: linked.slice(0, 8).map((contact) => ({
          name: contact.Name, title: contact.Title, agency: contact.Agency,
          organization: contact.Organization, email: contact.Email, phone: contact.Phone,
        })),
      }
    }

    case 'search_notes': {
      const query = String(args.query || '').trim().toLowerCase()
      const contractNumber = String(args.contractNumber || '').trim()
      const limit = Math.min(args.limit || 5, 10)
      let matchingNotes = notes.filter((note) => !isSystemNote(note))
      if (contractNumber) matchingNotes = matchingNotes.filter((note) => note.ContractNumber === contractNumber)
      if (query) {
        matchingNotes = matchingNotes.filter((note) =>
          [note.NoteText, note.Author, note.ContractNumber].some((value) => String(value || '').toLowerCase().includes(query))
        )
      }
      matchingNotes.sort((a, b) => new Date(b.Date || 0) - new Date(a.Date || 0))
      return {
        count: matchingNotes.length,
        notes: matchingNotes.slice(0, limit).map((note) => ({
          contractNumber: note.ContractNumber,
          date: note.Date,
          author: note.Author,
          text: String(note.NoteText || '').slice(0, 600),
        })),
      }
    }

    case 'search_tasks': {
      let rows = tasks
      if (args.status) rows = rows.filter((t) => t.Status === args.status)
      if (args.assignedTo) {
        const a = args.assignedTo.toLowerCase()
        rows = rows.filter((t) => String(t.AssignedTo || '').toLowerCase().includes(a))
      }
      if (args.contractNumber) rows = rows.filter((t) => t.ContractNumber === args.contractNumber)
      if (args.overdueOnly) rows = rows.filter(isOverdueTask)
      const limit = Math.min(args.limit || 5, 8)
      return {
        count: rows.length,
        tasks: rows.slice(0, limit).map(summarizeTask),
      }
    }

    case 'search_contacts': {
      return relationshipQuery.searchContacts(args.query, args.limit)
    }

    case 'get_contact_contracts':
      return relationshipQuery.getContactContracts(args)

    case 'query_crm_relationships':
      return queryCrmRelationships(data, args)

    case 'get_expiring_contracts': {
      const withinDays = args.withinDays || 180
      const today = new Date(); today.setHours(0, 0, 0, 0)
      const end = new Date(today); end.setDate(end.getDate() + withinDays)
      const rows = pipeline
        .filter((o) => {
          const d = new Date((o[C_END] || '') + 'T00:00:00')
          return !isNaN(d.getTime()) && d >= today && d <= end
        })
        .sort((a, b) => new Date(a[C_END]) - new Date(b[C_END]))
      return { count: rows.length, contracts: rows.slice(0, 8).map(summarizeOpportunity) }
    }

    case 'get_pipeline_metrics': {
      const total = pipeline.length
      const closed = pipeline.filter((o) => o[C_PHASE] === 'Contract Awarded').length
      const byPhase = {}
      pipeline.forEach((o) => { const p = o[C_PHASE]; if (p) byPhase[p] = (byPhase[p] || 0) + 1 })
      const totalValue = pipeline.reduce((sum, o) => {
        const n = parseFloat(String(o[C_VALUE] || '0').replace(/[^0-9.]/g, ''))
        return sum + (isNaN(n) ? 0 : n)
      }, 0)
      return {
        total, open: total - closed, closed, totalValue,
        byPhase, overdueTaskCount: tasks.filter(isOverdueTask).length,
      }
    }

    default:
      return { error: `Unknown tool: ${name}` }
  }
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
      submissionDate:    opportunity['Submission Date (Response Date)*']       || '',
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
