import { useState, useMemo, useCallback, useEffect } from 'react'
import { useParams, useNavigate, useSearchParams } from 'react-router-dom'
import { usePipeline } from '@/hooks/usePipeline'
import { useNotes } from '@/hooks/useNotes'
import { useTasks } from '@/hooks/useTasks'
import { useContacts } from '@/hooks/useContacts'
import { useAuth } from '@/auth/AuthContext'
import Topbar from '@/components/Layout/Topbar'
import AIPanel from '@/components/AI/AIPanel'
import { useAwardsLookup } from '@/hooks/useAwardsLookup'
import { useRfiFollowUps } from '@/hooks/useRfiFollowUps'
import AwardRecordCard from '@/components/Awards/AwardRecordCard'
import awardStyles from '@/components/Awards/AwardRecordCard.module.css'
import Modal from '@/components/Common/Modal'
import { formatDate, isOverdue } from '@/utils/kpiHelpers'
import { invalidateCache } from '@/services/dataCache'
import { buildEmailDraftContext, buildCapabilityStatementContext } from '@/services/groqService'
import { useValidationLists, pickList } from '@/hooks/useValidationLists'
import {
  OPPORTUNITY_PHASES, OPPORTUNITY_OUTLOOK, ACTIVITY_PHASES, SET_ASIDE_VALUES, PRIORITY_VALUES, ASSIGNEE_VALUES,
  parsePOCNames, parseRelatedOpportunityNote, linkRelatedOpportunities,
  previewOpportunityRename, renameOpportunityWithReferences,
} from '@/services/graphService'
import styles from './OpportunityDetail.module.css'

async function retryThrice(fn) {
  let lastErr
  for (let i = 0; i < 3; i++) {
    try { return await fn() } catch (err) { lastErr = err }
  }
  throw lastErr
}

// ── Column constants ──────────────────────────────────────────────────────
const C = {
  phase:          'TAG Opportunity Phase',
  actPhase:       'TAG Pipeline Activity Phase',
  contractNum:    'Contract Number / Notice ID',
  title:          'Project Title / Description*',
  agency:         'Agency*',
  department:     'Department*',
  office:         'Office*',
  value:          'Total Contract Value ($)*',
  baseValue:      'Base Year Value ($)*',
  assignedTo:     'Assigned To*',
  lastMod:        'Last Modified*',
  submDate:       'Submission Date (Response Date)*',
  solNum:         'Solicitation Number',
  naics:          'NAICS Code*',
  outlook:        'Opportunity Outlook',
  priority:       'Priority',
  setAside:       'Set- Aside*',
  poc:            'Contracting Officer / Specialist (POC)*',
  endDate:        'Contract End Date*',
  awardDate:      'Anticipated year for Award (MM/DD/YYYY)*',
  bidNoBid:       'Bid / No Bid?',
  partner:        'Partner',
  primeOrSub:     'Prime or Sub?',
  notes:          'Notes*',
  govwin:         'GovWin Link*',
  folder:         'Link to Folder',
  slideDeck:      'Link to Slide Deck',
  otherLinks:     'Other Links*',
  incumbent:      'Incumbent (Company Name)',
  fiscalYear:     'Fiscal Year',
  vehicleNumber:  'Contract Vehicle Number',
  vehicle:        'Contract Vehicle',
  classification: 'Contract Classification*',
}

// ── Helpers ───────────────────────────────────────────────────────────────
function safeUrl(url) {
  if (!url) return '#'
  const s = String(url).trim()
  if (s.startsWith('http://') || s.startsWith('https://') || s.startsWith('//')) return s
  return `https://${s}`
}

function normalizeOpportunityKey(value) {
  return String(value ?? '').trim().replace(/\s+/g, ' ').toLowerCase()
}

// ── Linkify note text ────────────────────────────────────────────────────
// Detects URLs inside a note's plain text and renders them as real,
// clickable links instead of inert text. Built as React elements (not
// dangerouslySetInnerHTML) so note text can never be interpreted as markup.
const URL_PATTERN = /(https?:\/\/[^\s<>"')]+|www\.[^\s<>"')]+)/gi

function linkifyText(text) {
  if (!text) return null
  // .split() with a single capturing group interleaves [text, match, text, match, ...]
  // — odd indices are always the captured URL matches, so no regex-statefulness
  // concerns from re-using .test()/.exec() with the global flag.
  return String(text).split(URL_PATTERN).map((part, i) => {
    if (i % 2 === 1) {
      const href = part.toLowerCase().startsWith('www.') ? `https://${part}` : part
      return (
        <a key={i} href={href} target="_blank" rel="noreferrer" style={{ wordBreak: 'break-all' }}>
          {part}
        </a>
      )
    }
    return part
  })
}

/**
 * "Other Links*" stores one or more URLs, newline-delimited, in a single cell.
 *
 * parseLinks/joinLinks preserve blank lines — this is the "draft" form used
 * while editing, so a freshly-added empty row (from the "+ Add link" button)
 * stays visible as its own input instead of being silently stripped back out
 * before the user has had a chance to type into it. cleanLinks drops blanks
 * and is used for read-only display and for what actually gets persisted.
 */
function parseLinks(val) {
  if (!val) return []
  return String(val).split('\n').map((s) => s.trim())
}
function joinLinks(arr) {
  return arr.join('\n')
}
function cleanLinks(val) {
  return parseLinks(val).filter(Boolean)
}

function addPOCName(currentPOC, contactName) {
  const names = parsePOCNames(currentPOC)
  return names.includes(contactName) ? names.join(', ') : [...names, contactName].join(', ')
}

function formatFieldValue(val) {
  if (val === null || val === undefined || val === '') return '—'
  if (val instanceof Date) return formatDate(val)
  if (typeof val === 'number') return val.toLocaleString()
  return String(val)
}

function fmtValue(v) {
  const n = parseFloat(String(v ?? '').replace(/[^0-9.]/g, ''))
  if (!n) return null
  if (n >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(2)}B`
  if (n >= 1_000_000)     return `$${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000)         return `$${(n / 1_000).toFixed(0)}K`
  return `$${n.toFixed(0)}`
}

const PHASE_BADGE = {
  'Identified':       'badge-tracking',
  'Research':         'badge-qualify',
  'Qualified':        'badge-qualify',
  'Proposal':         'badge-proposal',
  'Pending Award':    'badge-negotiation',
  'Contract Awarded': 'badge-award',
  'Cancelled':        'badge-closed-lost',
}

const STATUS_CYCLE = { 'To Do': 'In Progress', 'In Progress': 'Done', 'Done': 'To Do' }
const statusClass  = (s) => s === 'To Do' ? 'todo' : s === 'In Progress' ? 'progress' : 'done'

// ── Section wrapper ───────────────────────────────────────────────────────
function Section({ title, children }) {
  return (
    <div className={styles.section}>
      <div className={styles.sectionHeader}>{title}</div>
      <div className={`card ${styles.sectionCard}`}>{children}</div>
    </div>
  )
}

// ── Individual read/edit field ────────────────────────────────────────────
// Collapsible SAM.gov Award Lookup panel. It lazily fires the lookup the
// first time it's expanded (not on page load, to avoid spending the shared
// 1,000/day SAM API quota on panels nobody opens). Each returned field gets
// a hover-revealed "Update pipeline" button so the user can selectively
// pull in just the fields that changed, rather than an all-or-nothing sync.
// The PIID itself is intentionally display-only here: an award lookup can
// never overwrite the pipeline identifier.
function AwardLookupPanel({ opp, contractNumber, updateOpp, toast, awards }) {
  const [open, setOpen] = useState(false)
  const { results, loading, error, searched, cache, lookup } = awards
  // Tracks which specific fields have been applied this session, keyed by
  // PIID then field key, so the button can flip to a "✓ Updated" confirmed
  // state without needing a full re-lookup.
  const [updatedFields, setUpdatedFields] = useState({})
  const [updatingFields, setUpdatingFields] = useState({})

  const handleToggle = () => {
    const next = !open
    setOpen(next)
    if (next && !searched && !loading) {
      lookup({ piid: contractNumber })
    }
  }

  const handleUpdateField = async (piid, fieldKey, field) => {
    setUpdatingFields((prev) => ({ ...prev, [piid]: { ...prev[piid], [fieldKey]: true } }))
    try {
      await updateOpp(opp._rowIndex, { [field.column]: field.value }, opp)
      setUpdatedFields((prev) => ({ ...prev, [piid]: { ...prev[piid], [fieldKey]: true } }))
      toast?.success(`${field.column.replace(/\*$/, '')} updated`)
    } catch (err) {
      toast?.error(`Failed to update: ${err.message}`)
    } finally {
      setUpdatingFields((prev) => ({ ...prev, [piid]: { ...prev[piid], [fieldKey]: false } }))
    }
  }

  const handleAddAwardNoticeLink = async (piid, fieldKey, field) => {
    const link = String(field.value || '').trim()
    if (!link) return
    const existing = cleanLinks(opp[C.otherLinks])
    if (existing.some((value) => value.toLowerCase() === link.toLowerCase())) {
      toast?.success('Award Notice link is already in Other Links')
      setUpdatedFields((prev) => ({ ...prev, [piid]: { ...prev[piid], [fieldKey]: true } }))
      return
    }
    setUpdatingFields((prev) => ({ ...prev, [piid]: { ...prev[piid], [fieldKey]: true } }))
    try {
      await updateOpp(opp._rowIndex, { [C.otherLinks]: joinLinks([...existing, link]) }, opp)
      setUpdatedFields((prev) => ({ ...prev, [piid]: { ...prev[piid], [fieldKey]: true } }))
      toast?.success('Award Notice link added to Other Links')
    } catch (err) {
      toast?.error(`Failed to add link: ${err.message}`)
    } finally {
      setUpdatingFields((prev) => ({ ...prev, [piid]: { ...prev[piid], [fieldKey]: false } }))
    }
  }

  return (
    <div className="card" style={{ padding: 0, overflow: 'hidden', marginBottom: 12 }}>
      <button
        onClick={handleToggle}
        style={{
          display: 'flex', alignItems: 'center', gap: 10, width: '100%',
          padding: '12px 16px', background: 'var(--surface)', border: 'none', cursor: 'pointer',
          textAlign: 'left', fontFamily: 'var(--font)',
        }}
      >
        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--gray-900)', flex: 1 }}>
          Award Lookup
        </span>
        {loading && <span className="text-xs text-muted">Looking up…</span>}
        <span style={{
          fontSize: 18, color: 'var(--gray-400)', lineHeight: 1,
          transform: open ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform 0.2s',
        }}>›</span>
      </button>
      {open && (
        <div style={{ borderTop: '0.5px solid var(--gray-200)', padding: '12px 16px' }}>
          {loading && <p className="text-sm text-muted">Looking up award data for {contractNumber}…</p>}
          {error && <p className="text-sm" style={{ color: 'var(--red-600)' }}>Lookup failed: {error}</p>}
          {searched && !loading && !error && results.length === 0 && (
            <p className="text-sm text-muted">No award data found for {contractNumber}.</p>
          )}
          {results.map((r) => {
            const piid = r.piid || r.raw?.contractId?.piid
            const isIDV = r.isIDV
            return (
              <AwardRecordCard
                key={piid || Math.random()}
                piid={piid}
                isIDV={isIDV}
                modificationCount={r.modificationCount}
                originalSignedDate={r.originalSignedDate}
                samLink={r.samLink}
                cache={cache}
                onRefresh={() => lookup({ piid: contractNumber, forceRefresh: true })}
                refreshing={loading}
                fields={r.fields}
                renderFieldAction={(fieldKey, field) => {
                  const done = !!updatedFields[piid]?.[fieldKey]
                  const updating = !!updatingFields[piid]?.[fieldKey]
                  if (field.action === 'addOtherLink') {
                    return (
                      <button
                        className={`${awardStyles.fieldAction} ${done ? awardStyles.fieldActionDone : ''}`}
                        onClick={() => handleAddAwardNoticeLink(piid, fieldKey, field)}
                        disabled={done || updating}
                      >
                        {done ? 'Added' : updating ? 'Adding…' : 'Add to Other Links'}
                      </button>
                    )
                  }
                  if (!field.column) return null   // display-only field, nowhere in the pipeline to write it
                  return (
                    <button
                      className={`${awardStyles.fieldAction} ${done ? awardStyles.fieldActionDone : ''}`}
                      onClick={() => handleUpdateField(piid, fieldKey, field)}
                      disabled={done || updating}
                    >
                      {done ? '✓ Updated' : updating ? 'Updating…' : 'Update pipeline'}
                    </button>
                  )
                }}
              />
            )
          })}
        </div>
      )}
    </div>
  )
}

// RFI/Sources-Sought follow-up lookup. The request starts automatically for
// eligible RFIs; matching remains strict and is enforced by the Worker.
function RfiFollowUpPanel({ opp, pocEmail, linkedContractNumbers, onAddToPipeline }) {
  const ready = Boolean(opp?.[C.department] && opp?.[C.agency] && opp?.[C.title] && pocEmail)
  const { matches, loading, error, searched, refresh } = useRfiFollowUps({
    department: opp?.[C.department] || '',
    agency: opp?.[C.agency] || '',
    pocEmail: pocEmail || '',
    title: opp?.[C.title] || '',
    noticeId: opp?.[C.contractNum] || '',
    submissionDate: opp?.[C.submDate] || '',
  }, { enabled: ready })
  const [adding, setAdding] = useState(null)

  const add = async (candidate) => {
    const key = candidate.solicitationNumber || candidate.noticeId
    setAdding(key)
    try {
      await onAddToPipeline(candidate)
    } finally {
      setAdding(null)
    }
  }

  return (
    <div className="card" style={{ padding: 0, overflow: 'hidden', marginBottom: 12 }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '12px 16px', borderBottom: '0.5px solid var(--gray-200)' }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 13, fontWeight: 600 }}>RFI Follow-up Checker</div>
          <div className="text-xs text-muted" style={{ marginTop: 2 }}>Checks SAM.gov RFPs and RFQs for the same department, agency, POC email, and title keywords.</div>
        </div>
        <button className="btn text-sm" onClick={refresh} disabled={!ready || loading}>
          {loading ? 'Checking…' : 'Refresh'}
        </button>
      </div>
      <div style={{ padding: '12px 16px' }}>
        {!ready && <p className="text-sm text-muted">A department, agency, title, and linked POC email are required before follow-ups can be checked.</p>}
        {ready && loading && <p className="text-sm text-muted">Checking SAM.gov for RFP and RFQ follow-ons…</p>}
        {ready && error && <p className="text-sm" style={{ color: 'var(--red-600)' }}>Follow-up check failed: {error}</p>}
        {ready && searched && !loading && !error && matches.length === 0 && (
          <p className="text-sm text-muted">No matching follow-on RFPs or RFQs found.</p>
        )}
        {ready && matches.map((candidate) => {
          const key = candidate.solicitationNumber || candidate.noticeId
          const alreadyLinked = linkedContractNumbers.has(key)
          return (
            <div key={candidate.noticeId || key} style={{ borderTop: '0.5px solid var(--gray-100)', padding: '12px 0' }}>
              <div style={{ display: 'flex', gap: 12, justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 600 }}>{candidate.title || 'Untitled opportunity'}</div>
                  <div className="text-xs text-muted" style={{ marginTop: 3 }}>
                    {candidate.solicitationNumber || candidate.noticeId} · {candidate.type || 'Follow-on'} · {candidate.keywordOverlapPercent}% title overlap
                  </div>
                  {candidate.responseDate && <div className="text-xs text-muted" style={{ marginTop: 2 }}>Response: {formatDate(candidate.responseDate)}</div>}
                </div>
                <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                  {candidate.samLink && <a className="btn text-sm" href={safeUrl(candidate.samLink)} target="_blank" rel="noreferrer">SAM.gov ↗</a>}
                  <button className="btn btn-primary text-sm" onClick={() => add(candidate)} disabled={Boolean(adding) || alreadyLinked}>
                    {alreadyLinked ? 'Linked' : adding === key ? 'Adding…' : 'Add & link'}
                  </button>
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function Field({ label, value, editing, onChange, type = 'text', options = null, raw = false, span = false }) {
  return (
    <div className={`form-field ${span ? styles.spanFull : ''}`}>
      <label className="form-label">{label}</label>
      {editing
        ? options
          ? (
            <select className="form-input" value={value || ''}
              onChange={(e) => onChange(e.target.value)}>
              {options.map((o) => <option key={o}>{o}</option>)}
            </select>
          ) : (
            <input className="form-input" type={type} value={value || ''}
              onChange={(e) => onChange(e.target.value)} />
          )
        : (
          <div className="form-input" style={{ background: 'var(--gray-50)', color: 'var(--gray-900)' }}>
            {raw
              ? (value === null || value === undefined || value === '' ? '—' : String(value))
              : formatFieldValue(value)}
          </div>
        )
      }
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────
export default function OpportunityDetail({ toast }) {
  const { contractNumber } = useParams()
  const [searchParams] = useSearchParams()
  const decodedCN = decodeURIComponent(contractNumber || '')
  const rowParam = searchParams.get('row')
  const routeRowIndex = rowParam !== null && /^\d+$/.test(rowParam) ? Number(rowParam) : null
  const navigate  = useNavigate()
  const { user }  = useAuth()

  const { pipeline, loading: pipelineLoading, add: addPipelineOpp, update: updateOpp, remove: removeOpp } = usePipeline()
  const { notes, loading: notesLoading, add: addNote, remove: removeNote } = useNotes(decodedCN)
  const { tasks, add: addTask, update: updateTask, refreshContext } = useTasks(decodedCN)
  const { contacts, add: addContactRecord }  = useContacts()
  const { lists }     = useValidationLists()
  const awards = useAwardsLookup()

  const phaseOptions      = pickList(lists, 'TAG Opportunity Phase', OPPORTUNITY_PHASES)
  const activityPhaseOptions = pickList(lists, 'TAG Pipeline Activity Phase', ACTIVITY_PHASES)
  const outlookOptions    = pickList(lists, 'Opportunity Outlook',   OPPORTUNITY_OUTLOOK)
  const priorityOptions   = pickList(lists, 'Priority',              PRIORITY_VALUES)
  const setAsideOptions   = pickList(lists, 'Set-Aside',             SET_ASIDE_VALUES)
  const primeOrSubOptions = pickList(lists, 'Prime or Sub',          ['Prime', 'Sub'])
  const bidNoBidOptions   = pickList(lists, 'Bid / No Bid?',         ['Bid', 'No Bid', 'TBD'])
  const assigneeOptions   = pickList(lists, 'Assignee',              ASSIGNEE_VALUES)

  // ── All hooks before any early return ────────────────────────────────
  const [form,            setForm]            = useState(null)
  const [editing,         setEditing]         = useState(false)
  const [saving,          setSaving]          = useState(false)
  const [confirmDelete,   setConfirmDelete]   = useState(false)
  const [deleting,        setDeleting]        = useState(false)
  const [newNote,         setNewNote]         = useState('')
  const [addingNote,      setAddingNote]      = useState(false)
  const [deletingNoteId,  setDeletingNoteId]  = useState(null)
  const [showAddTask,     setShowAddTask]     = useState(false)
  const [savingTask,      setSavingTask]      = useState(false)
  const [updatingTaskId,  setUpdatingTaskId]  = useState(null)
  const [taskForm,        setTaskForm]        = useState({
    Title: '', Description: '', AssignedTo: '', DueDate: '', Priority: 'Medium',
  })
  const [contactSearch,   setContactSearch]   = useState('')
  const [linkingContact,  setLinkingContact]  = useState(false)
  const [showNewContact,  setShowNewContact]  = useState(false)
  const [savingContact,   setSavingContact]   = useState(false)
  const [newContactForm,  setNewContactForm]  = useState({
    Name: '', Title: '', Agency: '', Organization: '', Email: '', Phone: '', Type: 'Government',
  })
  const [hideDoneTasks, setHideDoneTasks] = useState(false)
  const [pendingRfiSave, setPendingRfiSave] = useState(null)
  const [pendingRenameSave, setPendingRenameSave] = useState(null)
  const [renamePreview, setRenamePreview] = useState(null)
  const [renameProgress, setRenameProgress] = useState('')
  

  const opp = useMemo(
    () => {
      const byRow = routeRowIndex !== null
        ? pipeline.find((o) => o._rowIndex === routeRowIndex)
        : null
      return byRow || pipeline.find((o) =>
        normalizeOpportunityKey(o[C.contractNum]) === normalizeOpportunityKey(decodedCN)
      )
    },
    [pipeline, decodedCN, routeRowIndex]
  )


  // ── Unsaved changes detection ──────────────────────────────────────
  const hasChanges = editing && form !== null && JSON.stringify(form) !== JSON.stringify(opp)


  // Block browser tab close / refresh
  useEffect(() => {
    const handler = (e) => {
      if (!hasChanges) return
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [hasChanges])

  const linkedContacts = useMemo(() => {
    if (!opp) return []
    const names = parsePOCNames(opp[C.poc])
    return names.map((name) => contacts.find((c) => c.Name === name)).filter(Boolean)
  }, [opp, contacts])

  const unlinkedContacts = useMemo(() => {
    const linked = new Set(linkedContacts.map((c) => c.Name))
    const q = contactSearch.trim().toLowerCase()
    if (!q) return []
    return contacts.filter((c) => {
      if (linked.has(c.Name)) return false
      return [c.Name, c.Agency, c.Email].some((v) => v?.toLowerCase().includes(q))
    }).slice(0, 20)
  }, [contacts, linkedContacts, contactSearch])

  const rfiPocEmail = useMemo(() => {
    const direct = String(opp?.[C.poc] || '').match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0]
    if (direct) return direct
    const names = new Set(parsePOCNames(opp?.[C.poc]))
    return contacts.find((contact) => names.has(contact.Name) && contact.Email)?.Email || ''
  }, [opp, contacts])

  const contact = useMemo(
    () => contacts.find((c) => c.Notes?.includes(decodedCN)),
    [contacts, decodedCN]
  )

  const relatedOpportunities = useMemo(
    () => notes.map((n) => parseRelatedOpportunityNote(n.NoteText)).filter(Boolean),
    [notes]
  )
  const visibleNotes = useMemo(
    () => notes.filter((n) => !parseRelatedOpportunityNote(n.NoteText)),
    [notes]
  )
  const recentNotesStr = visibleNotes.slice(0, 3).map((n) => n.NoteText).join(' | ')

  const isExpiringContract = opp?.[C.outlook] === 'Expiring'
  useEffect(() => {
    awards.reset()
  }, [decodedCN, isExpiringContract, awards.reset])

  useEffect(() => {
    if (!isExpiringContract || !decodedCN || awards.searched || awards.loading) return undefined

    const timer = window.setTimeout(() => {
      awards.lookup({ piid: decodedCN })
    }, 550)
    return () => window.clearTimeout(timer)
  }, [decodedCN, isExpiringContract, awards.loading, awards.lookup, awards.searched])

  const contractLifecycleAlert = useMemo(() => {
    if (!isExpiringContract) return null
    const result = awards.results.find((item) =>
      normalizeOpportunityKey(item.piid) === normalizeOpportunityKey(opp?.[C.contractNum] || decodedCN)
    )
    return result?.contractLifecycleAlert || null
  }, [awards.results, decodedCN, isExpiringContract, opp])

  const contractLifecycleTooltip = contractLifecycleAlert
    ? [
        contractLifecycleAlert.modificationNumber && `Modification ${contractLifecycleAlert.modificationNumber}`,
        contractLifecycleAlert.dateSigned && `Signed ${formatDate(contractLifecycleAlert.dateSigned)}`,
      ].filter(Boolean).join(' · ')
    : ''

  const contractLifecycleBadgeClass = contractLifecycleAlert?.type === 'closedOut'
    ? 'badge-tracking'
    : 'badge-closed-lost'

  const emailPrompt = useCallback(
    () => buildEmailDraftContext(opp ?? {}, contact, recentNotesStr),
    [opp, notes, contact, decodedCN]
  )

  const capPrompt = useCallback(
    () => buildCapabilityStatementContext(opp ?? {}, recentNotesStr),
    [opp, notes, decodedCN]
  )

  // ── Early returns after all hooks ─────────────────────────────────────
  if (pipelineLoading) {
    return (
      <div className="page-body">
        <div className="skeleton" style={{ height: 40, marginBottom: 12, width: 160 }} />
        <div className="skeleton" style={{ height: 28, marginBottom: 20, width: '60%' }} />
        <div className="card">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="skeleton" style={{ height: 36, marginBottom: 10 }} />
          ))}
        </div>
      </div>
    )
  }

  if (!opp) {
    return (
      <div className="page-body">
        <button className="btn btn-ghost" onClick={() => navigate('/opportunities')}>← Back</button>
        <p className="text-muted mt-3">Opportunity not found.</p>
      </div>
    )
  }

  // ── Helpers that depend on opp (safe below early returns) ─────────────
  const cur = form || opp

  const f = (key) => cur[key]
  const set = (key) => (val) => setForm((prev) => ({ ...prev, [key]: val }))
  const isRFI = opp[C.phase] === 'Identified' && opp[C.outlook] === 'New'
  const linkedContractNumbers = new Set(relatedOpportunities.map((related) => related.contractNumber))

  const handleEdit   = () => { setForm({ ...opp }); setEditing(true) }
  const handleCancel = () => { setForm(null); setEditing(false) }

  const persistOpportunity = async (nextForm) => {
    setSaving(true)
    try {
      // Strip any blank draft rows left over from editing Other Links
      // (e.g. an "+ Add link" row the user never filled in) before saving.
      await updateOpp(opp._rowIndex, nextForm, opp)
      toast?.success('Saved')
      setEditing(false)
      setForm(null)
    } catch (err) {
      toast?.error(`Save failed: ${err.message}`)
    } finally {
      setSaving(false)
    }
  }

  const prepareOpportunitySave = async (nextForm) => {
    const nextIdentifier = String(nextForm[C.contractNum] ?? '').trim()
    const nextTitle = String(nextForm[C.title] ?? '').trim()
    const cleanedRenameForm = {
      ...nextForm,
      [C.contractNum]: nextIdentifier,
      [C.title]: nextTitle,
    }
    const identifierChanged = nextIdentifier !== String(opp[C.contractNum] ?? '').trim()
    const titleChanged = nextTitle !== String(opp[C.title] ?? '').trim()

    if (!identifierChanged && !titleChanged) return persistOpportunity(cleanedRenameForm)

    setSaving(true)
    try {
      const preview = await previewOpportunityRename(opp._rowIndex, cleanedRenameForm)
      setRenamePreview(preview)
      setPendingRenameSave(cleanedRenameForm)
    } catch (err) {
      toast?.error(`Cannot update title or identifier: ${err.message}`)
    } finally {
      setSaving(false)
    }
  }

  const confirmRename = async () => {
    if (!pendingRenameSave) return
    setSaving(true)
    setRenameProgress('Preparing linked record updates…')
    try {
      const preview = await renameOpportunityWithReferences(
        opp._rowIndex,
        pendingRenameSave,
        ({ completed, total, label }) => {
          setRenameProgress(label === 'complete'
            ? 'Finishing…'
            : `Updating ${label} ${Math.min(completed + 1, total)} of ${total}…`)
        }
      )
      await invalidateCache()
      const newIdentifier = pendingRenameSave[C.contractNum]
      setPendingRenameSave(null)
      setRenamePreview(null)
      setEditing(false)
      setForm(null)
      toast?.success(
        preview.totalLinkedRecords
          ? `Saved and updated ${preview.totalLinkedRecords} linked record${preview.totalLinkedRecords === 1 ? '' : 's'}`
          : 'Saved'
      )
      if (newIdentifier !== opp[C.contractNum]) {
        navigate(`/opportunities/${encodeURIComponent(newIdentifier)}?row=${opp._rowIndex}`, { replace: true })
      }
    } catch (err) {
      toast?.error(err.message)
    } finally {
      setSaving(false)
      setRenameProgress('')
    }
  }

  const handleSave = () => {
    const cleanedForm = { ...form, [C.otherLinks]: joinLinks(cleanLinks(form[C.otherLinks])) }
    const needsActivityPrompt =
      cleanedForm[C.phase] === 'Identified' &&
      cleanedForm[C.outlook] === 'New' &&
      !opp[C.submDate] &&
      cleanedForm[C.submDate] &&
      !cleanedForm[C.actPhase]

    if (needsActivityPrompt) {
      setPendingRfiSave(cleanedForm)
      return
    }
    return prepareOpportunitySave(cleanedForm)
  }

  const handleDeleteOpportunity = async () => {
    setDeleting(true)
    try {
      await removeOpp(opp._rowIndex)
      toast?.success('Opportunity deleted')
      navigate('/opportunities')
    } catch (err) {
      toast?.error(`Failed to delete: ${err.message}`)
      setDeleting(false)
      setConfirmDelete(false)
    }
  }

  const handleAddNote = async () => {
    if (!newNote.trim()) return
    setAddingNote(true)
    try {
      await addNote(user.firstName, newNote.trim())
      setNewNote('')
      toast?.success('Note added')
    } catch (err) {
      toast?.error(`Failed to add note: ${err.message}`)
    } finally {
      setAddingNote(false)
    }
  }

  const handleDeleteNote = async (note) => {
    setDeletingNoteId(note._rowIndex)
    try {
      await removeNote(note._rowIndex)
      toast?.success('Note deleted')
    } catch (err) {
      toast?.error(`Failed to delete note: ${err.message}`)
    } finally {
      setDeletingNoteId(null)
    }
  }

  const handleTaskStatusChange = async (task, newStatus) => {
    setUpdatingTaskId(task.TaskID)
    try {
      await updateTask(task._rowIndex, { Status: newStatus })
    } catch (err) {
      toast?.error(`Failed: ${err.message}`)
    } finally {
      setUpdatingTaskId(null)
    }
  }

  const handleLinkContact = async (c) => {
    if (linkingContact) return
    setLinkingContact(true)
    setContactSearch('')
    // Optimistic: add contact to linked list immediately
    // The actual POC field updates come through cache refresh
    try {
      const nextPOC = addPOCName(opp[C.poc], c.Name)
      await retryThrice(() => updateOpp(opp._rowIndex, { [C.poc]: nextPOC }, opp))
      setForm((prev) => prev ? { ...prev, [C.poc]: nextPOC } : prev)
      toast?.success(`${c.Name} linked`)
    } catch (err) {
      // Silent fail — will resolve on next cache refresh, no visual rollback
      toast?.error(`Failed to link ${c.Name}`)
    } finally {
      setLinkingContact(false)
    }
  }

  const handleUnlinkContact = async (c) => {
    try {
      const nextPOC = parsePOCNames(opp[C.poc]).filter((name) => name !== c.Name).join(', ')
      await retryThrice(() => updateOpp(opp._rowIndex, { [C.poc]: nextPOC }, opp))
      setForm((prev) => prev ? { ...prev, [C.poc]: nextPOC } : prev)
      toast?.success(`${c.Name} unlinked`)
    } catch (err) {
      toast?.error(`Failed to unlink ${c.Name}`)
    }
  }

  const handleCreateAndLinkContact = async () => {
    const name = newContactForm.Name.trim()
    if (!name) { toast?.error('Name is required'); return }
    setSavingContact(true)
    try {
      await addContactRecord({ ...newContactForm, Name: name })
      const nextPOC = addPOCName(opp[C.poc], name)
      await retryThrice(() => updateOpp(opp._rowIndex, { [C.poc]: nextPOC }, opp))
      setForm((prev) => prev ? { ...prev, [C.poc]: nextPOC } : prev)
      toast?.success(`${name} added and linked`)
      setShowNewContact(false)
      setNewContactForm({ Name: '', Title: '', Agency: '', Organization: '', Email: '', Phone: '', Type: 'Government' })
    } catch (err) {
      toast?.error(`Failed to add contact: ${err.message}`)
    } finally {
      setSavingContact(false)
    }
  }

  const handleAddFollowOn = async (candidate) => {
    const contractNumber = candidate.solicitationNumber || candidate.noticeId
    if (!contractNumber) throw new Error('The follow-on notice has no solicitation or notice ID')

    const source = { contractNumber: opp[C.contractNum], title: opp[C.title] }
    const existing = pipeline.find((item) => item[C.contractNum] === contractNumber)
    if (existing) {
      await linkRelatedOpportunities(source, { contractNumber, title: existing[C.title] })
      await invalidateCache()
      toast?.success('Existing follow-on linked to this RFI')
      return
    }

    let contactName = contacts.find((contact) =>
      candidate.pocEmail && contact.Email?.trim().toLowerCase() === candidate.pocEmail.trim().toLowerCase()
    )?.Name || contacts.find((contact) => contact.Name === candidate.pocName)?.Name || ''

    if (!contactName && (candidate.pocName || candidate.pocEmail)) {
      contactName = candidate.pocName || candidate.pocEmail
      await addContactRecord({
        Name: contactName,
        Title: '',
        Agency: candidate.agency || '',
        Organization: candidate.department || '',
        Email: candidate.pocEmail || '',
        Phone: candidate.pocPhone || '',
        Type: 'Government',
        Notes: '',
      })
    }

    await addPipelineOpp({
      [C.phase]: 'Identified',
      [C.outlook]: 'New',
      [C.contractNum]: contractNumber,
      [C.title]: candidate.title || '',
      [C.solNum]: candidate.solicitationNumber || '',
      [C.setAside]: candidate.setAsideType || '',
      [C.department]: candidate.department || '',
      [C.agency]: candidate.agency || '',
      [C.office]: candidate.office || '',
      [C.naics]: candidate.naicsCode || '',
      [C.poc]: contactName,
      [C.submDate]: candidate.responseDate || '',
      [C.otherLinks]: candidate.samLink || '',
    })
    await linkRelatedOpportunities(source, { contractNumber, title: candidate.title || '' })
    await invalidateCache()
    toast?.success('Follow-on added and linked to this RFI')
  }

  const submitTask = async () => {
    setSavingTask(true)
    try {
      await addTask({
        ContractNumber: decodedCN,
        ContractTitle:  opp[C.title],
        ...taskForm,
        DueDate: taskForm.DueDate || '',
      }, user.displayName)
      setShowAddTask(false)
      setTaskForm({ Title: '', Description: '', AssignedTo: '', DueDate: '', Priority: 'Medium' })
      toast?.success('Task added')
    } catch (err) {
      toast?.error(`Failed to add task: ${err.message}`)
    } finally {
      setSavingTask(false)
    }
  }

  const valueFormatted = fmtValue(opp[C.value])

  // ── Render ────────────────────────────────────────────────────────────
  return (
    <>
      <Topbar
        title={opp[C.title]}
        subtitle1={decodedCN}
        subtitle2={
          editing
            ? undefined   // replaced by inline input below
            : opp[C.assignedTo] ? `Assigned: ${opp[C.assignedTo]}` : 'Unassigned'
        }
        showFilter={false}
        showNew={false}
        rightContent={contractLifecycleAlert && (
          <span className={`badge ${contractLifecycleBadgeClass}`} title={contractLifecycleTooltip}>
            {contractLifecycleAlert.reason}
          </span>
        )}
      />

      <div className="page-body">
        <button className="btn btn-ghost text-sm" style={{ marginBottom: 14 }}
          onClick={() => navigate('/opportunities')}>
          ← Opportunities
        </button>

        {/* ── Page header ── */}
        <div className={styles.pageHeader}>
          <div className={styles.pageHeaderLeft}>
            {/* Badges row — Phase and Outlook become dropdowns in edit mode */}
            <div className={styles.badgeRow}>
              {editing
                ? (
                  <>
                    <select
                      className={styles.badgeSelect}
                      value={f(C.phase) || ''}
                      onChange={(e) => set(C.phase)(e.target.value)}
                    >
                      {phaseOptions.map((p) => <option key={p}>{p}</option>)}
                    </select>
                    <select
                      className={styles.badgeSelect}
                      value={f(C.outlook) || ''}
                      onChange={(e) => set(C.outlook)(e.target.value)}
                    >
                      {outlookOptions.map((o) => <option key={o}>{o}</option>)}
                    </select>
                  </>
                )
                : (
                  <>
                    <span className={`badge ${PHASE_BADGE[opp[C.phase]] || 'badge-tracking'}`}>{opp[C.phase]}</span>
                    {opp[C.outlook] && <span className="badge badge-tracking">{opp[C.outlook]}</span>}
                  </>
                )
              }
              {f(C.priority) && (
                <span className={`badge ${f(C.priority) === 'Hot' ? 'badge-high' : f(C.priority) === 'Warm' ? 'badge-medium' : 'badge-low'}`}>
                  {f(C.priority)}
                </span>
              )}
              {valueFormatted && (
                <span className={styles.valueChip}>{valueFormatted}</span>
              )}
            </div>

            {/* Assigned To inline edit when editing */}
            {editing && (
              <div className={styles.assignedEditRow}>
                <label className="form-label" style={{ marginBottom: 0, whiteSpace: 'nowrap' }}>Assigned To</label>
                <select
                  className="form-input"
                  style={{ maxWidth: 220 }}
                  value={f(C.assignedTo) || ''}
                  onChange={(e) => set(C.assignedTo)(e.target.value)}
                >
                  <option value="">— Select —</option>
                  {assigneeOptions.map((a) => <option key={a}>{a}</option>)}
                </select>
              </div>
            )}
          </div>

          <div className={styles.pageHeaderActions}>
            {!editing
              ? (
                <>
                  <button
                    className="btn btn-ghost"
                    style={{ fontSize: 12, color: 'var(--blue-600)' }}
                    onClick={() => navigate(`/ai-chat?opportunity=${encodeURIComponent(decodedCN)}`)}
                    title="Discuss this opportunity with AI"
                  >✦ Discuss with AI</button>
                  <button className="btn" onClick={handleEdit}>Edit</button>
                  <button
                    className="btn btn-ghost"
                    style={{ fontSize: 12, color: 'var(--red-600)' }}
                    onClick={() => setConfirmDelete(true)}
                    title="Delete this opportunity"
                  >🗑 Delete</button>
                </>
              )
              : (
                <>
                  <button className="btn btn-ghost" onClick={handleCancel} disabled={saving}>Cancel</button>
                  <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
                    {saving ? 'Saving…' : 'Save'}
                  </button>
                </>
              )
            }
          </div>
        </div>

        {/* ── Section 1: Opportunity Details ── */}
        <Section title="Opportunity Details">
          <div className={styles.fieldGrid}>
            {editing && (
              <>
                <Field label="Opportunity Title" value={f(C.title)} editing onChange={set(C.title)} />
                <Field label="Contract Number / Notice ID" value={f(C.contractNum)} editing onChange={set(C.contractNum)} raw />
              </>
            )}
            <Field label="Agency"      value={f(C.agency)}     editing={editing} onChange={set(C.agency)} />
            <Field label="Department"  value={f(C.department)} editing={editing} onChange={set(C.department)} />
            <Field label="Office"                  value={f(C.office)}         editing={editing} onChange={set(C.office)} />
            <Field label="NAICS Code"              value={f(C.naics)}          editing={editing} onChange={set(C.naics)}           raw />
            <Field label="Set-Aside"               value={f(C.setAside)}       editing={editing} onChange={set(C.setAside)}       options={setAsideOptions} />
            <Field label="Contract Vehicle Number" value={f(C.vehicleNumber)}  editing={editing} onChange={set(C.vehicleNumber)} />
            <Field label="Contract Vehicle"        value={f(C.vehicle)}        editing={editing} onChange={set(C.vehicle)} />
            <Field label="Contract Classification" value={f(C.classification)} editing={editing} onChange={set(C.classification)} />
            <Field label="Incumbent"               value={f(C.incumbent)}      editing={editing} onChange={set(C.incumbent)} />
          </div>
        </Section>

        {/* ── Section 2: Contract Value ── */}
        <Section title="Contract Value">
          <div className={styles.fieldGrid}>
            <Field label="Total Contract Value ($)" value={f(C.value)}     editing={editing} onChange={set(C.value)}     type="number" />
            <Field label="Base Year Value ($)"      value={f(C.baseValue)} editing={editing} onChange={set(C.baseValue)} type="number" />
          </div>
        </Section>

        {/* ── Section 3: Timeline ── */}
        {(() => {
          return (
            <Section title="Timeline">
              <div className={styles.fieldGrid}>
                {isRFI && (
                  <Field label="RFI Submission Date" value={f(C.submDate)} editing={editing} onChange={set(C.submDate)} type="date" />
                )}
                <Field label="Contract End Date"      value={f(C.endDate)}    editing={editing} onChange={set(C.endDate)}    type="date" />
                <Field label="Anticipated Award Date" value={f(C.awardDate)}  editing={editing} onChange={set(C.awardDate)}  type="date" />
                <Field label="Fiscal Year"            value={f(C.fiscalYear)} editing={editing} onChange={set(C.fiscalYear)} />
              </div>
            </Section>
          )
        })()}

        {/* ── Section 4: Pursuit ── */}
        <Section title="Pursuit">
          <div className={styles.fieldGrid}>
            <Field label="Solicitation Number"   value={f(C.solNum)}    editing={editing} onChange={set(C.solNum)} />
            <Field label="Activity Phase"        value={f(C.actPhase)}  editing={editing} onChange={set(C.actPhase)} options={activityPhaseOptions} />
            <Field label="Bid / No Bid?"         value={f(C.bidNoBid)}  editing={editing} onChange={set(C.bidNoBid)}  options={bidNoBidOptions} />
            <Field label="Prime or Sub?"         value={f(C.primeOrSub)} editing={editing} onChange={set(C.primeOrSub)} options={primeOrSubOptions} />
            <Field label="Partner"               value={f(C.partner)}   editing={editing} onChange={set(C.partner)} />
            <Field label="Priority"              value={f(C.priority)}  editing={editing} onChange={set(C.priority)}  options={priorityOptions} />
          </div>
        </Section>

        {/* ── Section 5: Contacts ── */}
        <Section title="Contacts">
          {linkedContacts.length > 0
            ? linkedContacts.map((c) => (
                <div key={c.ContactID} className={styles.contactCard}>
                  <div className={styles.contactAv}>
                    {c.Name?.split(' ').map((n) => n[0]).slice(0, 2).join('')}
                  </div>
                  <div className={styles.contactInfo}>
                    <div className={styles.contactName}>{c.Name}</div>
                    <div className={styles.contactSub}>
                      {c.Email
                        ? <a href={`mailto:${c.Email}`} className="text-sm">{c.Email}</a>
                        : c.Title || '—'}
                    </div>
                  </div>
                  <button
                    className="btn btn-ghost btn-icon"
                    title="Unlink contact"
                    onClick={() => handleUnlinkContact(c)}
                  >✕</button>
                </div>
              ))
            : <p className="text-sm text-muted" style={{ marginBottom: 8 }}>No contacts linked.</p>
          }

          {/* Contact search — always visible */}
          <div style={{ position: 'relative', marginTop: linkedContacts.length > 0 ? 10 : 0 }}>
            <div style={{ display: 'flex', gap: 6 }}>
              <input
                className="form-input"
                placeholder="Search contacts to link…"
                value={contactSearch}
                onChange={(e) => setContactSearch(e.target.value)}
                style={{ flex: 1 }}
              />
              <button
                type="button"
                className="btn text-sm"
                style={{ flexShrink: 0 }}
                onClick={() => setShowNewContact((v) => !v)}
              >
                {showNewContact ? 'Cancel' : '+ New contact'}
              </button>
            </div>
            {contactSearch && (
              <div className={styles.contactDropdown}>
                {unlinkedContacts.length === 0
                  ? <div className={styles.contactDropdownEmpty}>No contacts found.</div>
                  : unlinkedContacts.map((c) => (
                      <div
                        key={c.ContactID || c.Name}
                        className={styles.contactDropdownRow}
                        onClick={() => !linkingContact && handleLinkContact(c)}
                      >
                        <div className={styles.contactDropdownName}>{c.Name || '—'}</div>
                        <div className={styles.contactDropdownSub}>{c.Agency || c.Email || '—'}</div>
                      </div>
                    ))
                }
              </div>
            )}
          </div>

          {/* Inline "new contact" form */}
          {showNewContact && (
            <div className="card" style={{ marginTop: 10, padding: 12 }}>
              <div className={styles.fieldGrid}>
                <div className="form-field">
                  <label className="form-label">Name *</label>
                  <input className="form-input" required value={newContactForm.Name}
                    onChange={(e) => setNewContactForm((f) => ({ ...f, Name: e.target.value }))} />
                </div>
                <div className="form-field">
                  <label className="form-label">Title</label>
                  <input className="form-input" value={newContactForm.Title}
                    onChange={(e) => setNewContactForm((f) => ({ ...f, Title: e.target.value }))} />
                </div>
                <div className="form-field">
                  <label className="form-label">Agency</label>
                  <input className="form-input" value={newContactForm.Agency}
                    onChange={(e) => setNewContactForm((f) => ({ ...f, Agency: e.target.value }))} />
                </div>
                <div className="form-field">
                  <label className="form-label">Organization</label>
                  <input className="form-input" value={newContactForm.Organization}
                    onChange={(e) => setNewContactForm((f) => ({ ...f, Organization: e.target.value }))} />
                </div>
                <div className="form-field">
                  <label className="form-label">Email</label>
                  <input className="form-input" type="email" value={newContactForm.Email}
                    onChange={(e) => setNewContactForm((f) => ({ ...f, Email: e.target.value }))} />
                </div>
                <div className="form-field">
                  <label className="form-label">Phone</label>
                  <input className="form-input" value={newContactForm.Phone}
                    onChange={(e) => setNewContactForm((f) => ({ ...f, Phone: e.target.value }))} />
                </div>
                <div className="form-field">
                  <label className="form-label">Type</label>
                  <select className="form-input" value={newContactForm.Type}
                    onChange={(e) => setNewContactForm((f) => ({ ...f, Type: e.target.value }))}>
                    <option>Government</option>
                    <option>Private</option>
                  </select>
                </div>
              </div>
              <button
                type="button"
                className="btn btn-primary text-sm"
                style={{ marginTop: 10 }}
                onClick={handleCreateAndLinkContact}
                disabled={savingContact || !newContactForm.Name.trim()}
              >
                {savingContact ? 'Adding…' : 'Add & link contact'}
              </button>
            </div>
          )}
        </Section>

        {/* ── Section 6: Links ── */}
        <Section title="Links">
          {editing
            ? (
              <div className={styles.fieldGrid}>
                <Field label="GovWin Link"       value={f(C.govwin)}     editing onChange={set(C.govwin)} />
                <Field label="Link to Folder"    value={f(C.folder)}     editing onChange={set(C.folder)} />
                <Field label="Link to Slide Deck" value={f(C.slideDeck)} editing onChange={set(C.slideDeck)} />
                <div className={`form-field ${styles.spanFull}`}>
                  <label className="form-label">Other Links</label>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {(parseLinks(f(C.otherLinks)).length > 0 ? parseLinks(f(C.otherLinks)) : ['']).map((link, i) => {
                      const links = parseLinks(f(C.otherLinks)).length > 0 ? parseLinks(f(C.otherLinks)) : ['']
                      return (
                        <div key={i} style={{ display: 'flex', gap: 6 }}>
                          <input
                            className="form-input"
                            placeholder="https://…"
                            value={link}
                            onChange={(e) => {
                              const next = [...links]
                              next[i] = e.target.value
                              set(C.otherLinks)(joinLinks(next))
                            }}
                          />
                          <button
                            type="button"
                            className="btn btn-ghost btn-icon"
                            aria-label="Remove link"
                            title="Remove link"
                            onClick={() => {
                              const next = links.filter((_, j) => j !== i)
                              set(C.otherLinks)(joinLinks(next))
                            }}
                          >✕</button>
                        </div>
                      )
                    })}
                    <button
                      type="button"
                      className="btn text-sm"
                      style={{ alignSelf: 'flex-start' }}
                      onClick={() => set(C.otherLinks)(joinLinks([...parseLinks(f(C.otherLinks)), '']))}
                    >
                      + Add link
                    </button>
                  </div>
                </div>
              </div>
            )
            : (() => {
                const otherLinkList = cleanLinks(cur[C.otherLinks])
                const fixedLinks = [
                  [C.govwin,    'GovWin ↗'],
                  [C.folder,    '📁 Folder ↗'],
                  [C.slideDeck, '📊 Slide Deck ↗'],
                ].filter(([key]) => cur[key])
                if (fixedLinks.length === 0 && otherLinkList.length === 0) {
                  return <p className="text-sm text-muted">No links added.</p>
                }
                return (
                  <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                    {fixedLinks.map(([key, label]) => (
                      <a key={key} href={safeUrl(cur[key])} target="_blank" rel="noreferrer" className="btn text-sm">{label}</a>
                    ))}
                    {otherLinkList.map((link, i) => (
                      <a key={i} href={safeUrl(link)} target="_blank" rel="noreferrer" className="btn text-sm">
                        🔗 Other Link{otherLinkList.length > 1 ? ` ${i + 1}` : ''} ↗
                      </a>
                    ))}
                  </div>
                )
              })()
          }
        </Section>

        {/* ── Section 7: Notes ── */}
        {relatedOpportunities.length > 0 && (
          <Section title="Related Opportunities">
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {relatedOpportunities.map((related) => (
                <button
                  key={related.contractNumber}
                  type="button"
                  className="btn"
                  style={{ justifyContent: 'space-between', textAlign: 'left' }}
                  onClick={() => navigate(`/opportunities/${encodeURIComponent(related.contractNumber)}`)}
                >
                  <span>{related.title || related.contractNumber}</span>
                  <span className="text-xs text-muted">{related.contractNumber} ↗</span>
                </button>
              ))}
            </div>
          </Section>
        )}

        <Section title="Notes">
          {notesLoading
            ? <div className="skeleton" style={{ height: 60 }} />
            : visibleNotes.length === 0
              ? <p className="text-muted text-sm" style={{ marginBottom: 10 }}>No notes yet.</p>
              : visibleNotes.map((n) => (
                  <div key={n.NoteID} className={styles.noteItem}>
                    <div className={styles.noteMeta} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span>{n.Date} · {n.Author}</span>
                      {editing && (
                        <button
                          type="button"
                          className="btn btn-ghost btn-icon"
                          style={{ width: 18, height: 18, padding: 0, fontSize: 11, color: 'var(--red-600)', marginLeft: 'auto' }}
                          onClick={() => handleDeleteNote(n)}
                          disabled={deletingNoteId === n._rowIndex}
                          aria-label="Delete note"
                          title="Delete note"
                        >
                          {deletingNoteId === n._rowIndex ? '…' : '✕'}
                        </button>
                      )}
                    </div>
                    <div className={styles.noteText}>{linkifyText(n.NoteText)}</div>
                  </div>
                ))
          }
          <div className={styles.noteAdd}>
            <textarea
              className="form-input"
              placeholder="Add a note…"
              value={newNote}
              onChange={(e) => setNewNote(e.target.value)}
              rows={2}
            />
            <button className="btn btn-primary text-sm" onClick={handleAddNote}
              disabled={addingNote || !newNote.trim()}>
              {addingNote ? 'Adding…' : 'Add note'}
            </button>
          </div>
        </Section>

        {/* ── Section 8: Tasks ── */}
        <Section title="Tasks">
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8 }}>
            <button
              type="button"
              className={`filter-chip ${hideDoneTasks ? 'active' : ''}`}
              onClick={() => setHideDoneTasks((value) => !value)}
            >
              Hide completed
            </button>
          </div>
          {tasks.filter((t) => !hideDoneTasks || t.Status !== 'Done').length === 0
            ? <p className="text-muted text-sm" style={{ marginBottom: 8 }}>No tasks for this opportunity.</p>
            : tasks.filter((t) => !hideDoneTasks || t.Status !== 'Done').map((t) => {
                const over = isOverdue(t.DueDate) && t.Status !== 'Done'
                return (
                  <div key={t.TaskID} className={styles.taskRow}>
                    <div style={{ flex: 1 }}>
                      <div className={styles.taskTitle}>{t.Title}</div>
                      <div className={styles.taskMeta}>
                        <span className={`badge badge-${t.Priority?.toLowerCase()}`}>{t.Priority}</span>
                        <span className={over ? 'text-danger text-xs' : 'text-muted text-xs'}>
                          {formatDate(t.DueDate)}{over ? ' · overdue' : ''}
                        </span>
                      </div>
                      {t.OpportunityNotes && (
                        <button className={styles.refreshCtx} onClick={() => refreshContext(t)}>
                          ↺ Refresh context
                        </button>
                      )}
                    </div>
                    <button
                      className={`badge badge-${statusClass(t.Status)}`}
                      style={{
                        cursor: updatingTaskId === t.TaskID ? 'default' : 'pointer',
                        border: 'none',
                        opacity: updatingTaskId === t.TaskID ? 0.6 : 1,
                      }}
                      onClick={() => handleTaskStatusChange(t, STATUS_CYCLE[t.Status] || 'To Do')}
                      disabled={updatingTaskId === t.TaskID}
                      title="Click to advance status"
                    >
                      {updatingTaskId === t.TaskID ? 'Updating…' : t.Status}
                    </button>
                  </div>
                )
              })
          }
          <button className="btn text-sm w-full" style={{ marginTop: 8, justifyContent: 'center' }}
            onClick={() => setShowAddTask(true)}>
            + Add task
          </button>
        </Section>

        {/* ── RFI follow-up / Award lookup ── */}
        {isRFI && (
          <RfiFollowUpPanel
            opp={opp}
            pocEmail={rfiPocEmail}
            linkedContractNumbers={linkedContractNumbers}
            onAddToPipeline={handleAddFollowOn}
          />
        )}
        <AwardLookupPanel
          opp={opp}
          contractNumber={decodedCN}
          updateOpp={updateOpp}
          toast={toast}
          awards={awards}
        />

        {/* ── AI panels ── */}
        <AIPanel title="Draft follow-up email"        buildPrompt={emailPrompt} defaultCollapsed />
        <AIPanel title="Generate capability statement" buildPrompt={capPrompt}   defaultCollapsed />
      </div>

      {/* ── Add task modal ── */}
      {showAddTask && (
        <Modal title="Add task" onClose={() => !savingTask && setShowAddTask(false)}
          footer={
            <>
              <button className="btn" onClick={() => setShowAddTask(false)} disabled={savingTask}>Cancel</button>
              <button className="btn btn-primary" onClick={submitTask} disabled={savingTask}>
                {savingTask ? 'Adding…' : 'Add task'}
              </button>
            </>
          }
        >
          <form onSubmit={(e) => { e.preventDefault(); submitTask() }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div className="form-field">
                <label className="form-label">Title *</label>
                <input className="form-input" required value={taskForm.Title}
                  onChange={(e) => setTaskForm({ ...taskForm, Title: e.target.value })} />
              </div>
              <div className="form-field">
                <label className="form-label">Description</label>
                <textarea className="form-input" rows={3} value={taskForm.Description}
                  onChange={(e) => setTaskForm({ ...taskForm, Description: e.target.value })} />
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div className="form-field">
                  <label className="form-label">Assigned to</label>
                  <select className="form-input" value={taskForm.AssignedTo}
                    onChange={(e) => setTaskForm({ ...taskForm, AssignedTo: e.target.value })}>
                    <option value="">— Select —</option>
                    {assigneeOptions.map((a) => <option key={a}>{a}</option>)}
                  </select>
                </div>
                <div className="form-field">
                  <label className="form-label">Due date</label>
                  <input className="form-input" type="date" value={taskForm.DueDate}
                    onChange={(e) => setTaskForm({ ...taskForm, DueDate: e.target.value })} />
                </div>
                <div className="form-field">
                  <label className="form-label">Priority</label>
                  <select className="form-input" value={taskForm.Priority}
                    onChange={(e) => setTaskForm({ ...taskForm, Priority: e.target.value })}>
                    <option>Low</option><option>Medium</option><option>High</option>
                  </select>
                </div>
              </div>
            </div>
          </form>
        </Modal>
      )}

      {pendingRfiSave && (
        <Modal
          title="Update activity phase?"
          onClose={() => setPendingRfiSave(null)}
          footer={
            <>
              <button className="btn" onClick={() => {
                const pending = pendingRfiSave
                setPendingRfiSave(null)
                prepareOpportunitySave(pending)
              }}>
                Not now
              </button>
              <button className="btn btn-primary" onClick={() => {
                const pending = { ...pendingRfiSave, [C.actPhase]: 'Submitted RFI' }
                setPendingRfiSave(null)
                prepareOpportunitySave(pending)
              }}>
                Set to Submitted RFI
              </button>
            </>
          }
        >
          <p className="text-sm">An RFI submission date was added. Update this opportunity's Activity Phase to Submitted RFI?</p>
        </Modal>
      )}

      {pendingRenameSave && renamePreview && (
        <Modal
          title="Confirm title or identifier change"
          onClose={() => {
            if (saving) return
            setPendingRenameSave(null)
            setRenamePreview(null)
          }}
          footer={
            <>
              <button
                className="btn"
                disabled={saving}
                onClick={() => {
                  setPendingRenameSave(null)
                  setRenamePreview(null)
                }}
              >
                Cancel
              </button>
              <button className="btn btn-primary" onClick={confirmRename} disabled={saving}>
                {saving ? (renameProgress || 'Saving…') : 'Confirm and update linked records'}
              </button>
            </>
          }
        >
          <p className="text-sm" style={{ marginTop: 0 }}>
            This change updates the opportunity and its structured links across the pipeline.
          </p>
          <ul className="text-sm" style={{ margin: '10px 0', paddingLeft: 20, lineHeight: 1.7 }}>
            {renamePreview.identifierChanged && (
              <li>Identifier: <strong>{opp[C.contractNum]}</strong> to <strong>{pendingRenameSave[C.contractNum]}</strong></li>
            )}
            {renamePreview.titleChanged && (
              <li>Title: <strong>{opp[C.title]}</strong> to <strong>{pendingRenameSave[C.title]}</strong></li>
            )}
            <li>{renamePreview.taskCount} linked task{renamePreview.taskCount === 1 ? '' : 's'} will be updated</li>
            <li>{renamePreview.noteCount} linked note{renamePreview.noteCount === 1 ? '' : 's'} will be updated</li>
            <li>{renamePreview.relationshipCount} related-opportunity link{renamePreview.relationshipCount === 1 ? '' : 's'} will be updated</li>
          </ul>
          <p className="text-sm text-muted" style={{ marginBottom: 0 }}>
            Free-text task descriptions and notes, contacts, and Expiring Contract Number will not be changed. If a linked write fails, completed linked changes are rolled back where possible and you will be told to review the affected records.
          </p>
          {saving && renameProgress && <p className="text-sm" style={{ marginBottom: 0 }}>{renameProgress}</p>}
        </Modal>
      )}

      {/* ── Delete confirmation modal ── */}
      {confirmDelete && (
        <Modal
          title="Delete opportunity"
          onClose={() => !deleting && setConfirmDelete(false)}
          footer={
            <>
              <button className="btn" onClick={() => setConfirmDelete(false)} disabled={deleting}>Cancel</button>
              <button className="btn btn-danger" onClick={handleDeleteOpportunity} disabled={deleting}>
                {deleting ? 'Deleting…' : 'Delete'}
              </button>
            </>
          }
        >
          <p className="text-sm">
            Delete <strong>{opp[C.title]}</strong> ({decodedCN})?
            This removes it from the pipeline permanently and cannot be undone.
          </p>
        </Modal>
      )}
    </>
  )
}
