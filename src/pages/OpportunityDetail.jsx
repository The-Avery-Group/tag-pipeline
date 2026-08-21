import { useState, useMemo, useEffect, useRef } from 'react'
import { useParams, useNavigate, useSearchParams } from 'react-router-dom'
import { usePipeline } from '@/hooks/usePipeline'
import { useNotes } from '@/hooks/useNotes'
import { useTasks } from '@/hooks/useTasks'
import { useContacts } from '@/hooks/useContacts'
import { usePartners } from '@/hooks/usePartners'
import { useAuth } from '@/auth/AuthContext'
import Topbar from '@/components/Layout/Topbar'
import { useAwardsLookup } from '@/hooks/useAwardsLookup'
import { useEntityEightA } from '@/hooks/useEntityEightA'
import { useRfiFollowUpMonitor } from '@/hooks/useRfiFollowUpMonitor'
import { useSAMChangeSuggestion } from '@/hooks/useSAMChangeSuggestion'
import { useOpportunityAlerts } from '@/hooks/useOpportunityAlerts'
import IncumbentAwardHistoryPanel from '@/components/Opportunity/IncumbentAwardHistory'
import AwardLookupPanel from '@/components/Opportunity/AwardLookupPanel'
import PeopleSearch from '@/components/PeopleSearch/PeopleSearch'
import RfiFollowUpPanel from '@/components/Opportunity/RfiFollowUpPanel'
import RelatedContactsPanel from '@/components/Opportunity/RelatedContactsPanel'
import SAMChangeSuggestion from '@/components/Opportunity/SAMChangeSuggestion'
import OpportunityField from '@/components/Opportunity/OpportunityField'
import Section from '@/components/Opportunity/OpportunitySection'
import OpportunityNotesSection from '@/components/Opportunity/OpportunityNotesSection'
import OpportunityTasksSection from '@/components/Opportunity/OpportunityTasksSection'
import FollowUpEmailComposer from '@/components/Opportunity/FollowUpEmailComposer'
import OpportunityFilesPanel from '@/components/Opportunity/OpportunityFilesPanel'
import { OpportunityRenameModal, RfiActivityPhaseModal } from '@/components/Opportunity/OpportunitySaveModals'
import Modal from '@/components/Common/Modal'
import ActionIcon from '@/components/Common/ActionIcon'
import { formatDate } from '@/utils/kpiHelpers'
import { dateOnly, localDate, sbaProfileUrl } from '@/utils/opportunityDates'
import { needsRfiActivityPhasePrompt } from '@/utils/opportunityFormRules'
import {
  invalidateCache,
  publishCacheUpdate,
  verifyCacheInBackground,
} from '@/services/dataCache'
import { retryIdempotent } from '@/services/workbookMutations'
import {
  announceOpportunityFilesChanged,
  noteWithReferenceLinks,
  rollbackOpportunityReferenceFiles,
  uploadOpportunityReferenceFiles,
} from '@/services/opportunityReferenceUploadService'
import { useValidationLists, pickList } from '@/hooks/useValidationLists'
import {
  OPPORTUNITY_PHASES, OPPORTUNITY_OUTLOOK, ACTIVITY_PHASES, SET_ASIDE_VALUES, PRIORITY_VALUES, ASSIGNEE_VALUES,
  parsePOCNames, parseRelatedOpportunityNote, linkRelatedOpportunities,
  previewOpportunityRename, renameOpportunityWithReferences,
  saveRFIFollowUpDecision, saveRFIFollowUpOverride,
} from '@/services/graphService'
import styles from './OpportunityDetail.module.css'
import { useSaveShortcut } from '@/shortcuts/SaveShortcutContext'
import {
  NOTICE_TYPE_VALUES,
  isFollowOnSourceOpportunity,
  isResponseOpportunity,
  normalizeNoticeType,
} from '@/utils/noticeTypes'
import { isSAMOpportunityFlagged } from '@/utils/samOpportunityHelpers'

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
  incumbentUEI:   'Incumbent (Company UEI)',
  fiscalYear:     'Fiscal Year',
  vehicleNumber:  'Contract Vehicle Number',
  vehicle:        'Contract Vehicle',
  classification: 'Contract Classification*',
  noticeType:     'Notice Type',
  flagged:        'Flagged',
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

function opportunityReturnPath(value) {
  // Return destinations are only ever created by the Opportunities page.
  // Keep this guard so a manually edited URL cannot navigate outside the app.
  return typeof value === 'string' && /^\/opportunities(?:\?|$)/.test(value)
    ? value
    : '/opportunities'
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

function inferredLinkLabel(url) {
  try {
    const host = new URL(safeUrl(url)).hostname.replace(/^www\./, '')
    if (/sam\.gov$/i.test(host)) return 'SAM.gov opportunity'
    if (/sharepoint\.com$/i.test(host)) return 'SharePoint folder'
    if (/1drv\.ms|onedrive\.live\.com$/i.test(host)) return 'OneDrive file'
    if (/govwin\.com$/i.test(host)) return 'GovWin opportunity'
    return host || 'External link'
  } catch {
    return 'External link'
  }
}

function parseNamedLink(line) {
  const value = String(line || '').trim()
  const separator = value.match(/^(.+?)\s*\|\s*((?:https?:\/\/|www\.)\S+)$/i)
  const url = separator ? separator[2].trim() : value
  return { label: separator?.[1]?.trim() || inferredLinkLabel(url), url }
}

function namedLinkLine(label, url) {
  const cleanUrl = String(url || '').trim()
  if (!cleanUrl) return ''
  const cleanLabel = String(label || '').trim()
  return cleanLabel && cleanLabel !== inferredLinkLabel(cleanUrl) ? `${cleanLabel} | ${cleanUrl}` : cleanUrl
}

function addPOCName(currentPOC, contactName) {
  const names = parsePOCNames(currentPOC)
  return names.includes(contactName) ? names.join(', ') : [...names, contactName].join(', ')
}

function normalizeContactMatchText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\bdept\b/g, 'department')
    .replace(/\bprog\b/g, 'program')
    .replace(/\bops\b/g, 'operations')
    .replace(/\s+/g, ' ')
    .trim()
}

function officeValues(value) {
  return String(value || '')
    .split(',')
    .map((office) => office.trim())
    .filter(Boolean)
}

const GENERIC_OFFICE_WORDS = new Set([
  'and', 'the', 'of', 'for', 'in', 'at', 'office', 'department', 'agency', 'division', 'bureau', 'services',
])

function meaningfulOfficeTokens(value) {
  return normalizeContactMatchText(value)
    .split(' ')
    .filter((word) => word.length > 2 && !GENERIC_OFFICE_WORDS.has(word))
}

/**
 * Intentionally conservative: an exact normalized match always qualifies;
 * otherwise offices need a clear containment relationship or at least two
 * meaningful words in common. Agency matching is handled by the caller.
 */
function officeMatch(left, right) {
  const normalizedLeft = normalizeContactMatchText(left)
  const normalizedRight = normalizeContactMatchText(right)
  if (!normalizedLeft || !normalizedRight) return false
  if (normalizedLeft === normalizedRight) return true

  const leftTokens = meaningfulOfficeTokens(left)
  const rightTokens = meaningfulOfficeTokens(right)
  if (!leftTokens.length || !rightTokens.length) return false

  const leftMeaningful = leftTokens.join(' ')
  const rightMeaningful = rightTokens.join(' ')
  if (leftMeaningful.length >= 5 && rightMeaningful.length >= 5 &&
      (leftMeaningful.includes(rightMeaningful) || rightMeaningful.includes(leftMeaningful))) return true

  const rightSet = new Set(rightTokens)
  const overlap = leftTokens.filter((token) => rightSet.has(token))
  return overlap.length >= 2
}

function contactKey(contact) {
  return String(contact?.ContactID || contact?._rowIndex || contact?.Email || contact?.Name || '')
}

function findIncumbentPartner(incumbentUEI, partners) {
  const uei = String(incumbentUEI || '').trim().toUpperCase()
  if (!uei) return null
  const partner = partners.find((record) => String(record['UEI Number'] || '').trim().toUpperCase() === uei)
  return partner ? { partner, matchType: 'UEI' } : null
}

function formatFieldValue(val) {
  if (val === null || val === undefined || val === '') return '—'
  if (val instanceof Date) return formatDate(val)
  if (typeof val === 'number') return val.toLocaleString()
  return String(val)
}

function EightAExitCallout({ entityData, incumbentUEI, loading, error, contractEndDate, onAddNote, addingNote, noteAdded }) {
  const hasValidUEI = /^[A-Z0-9]{12}$/.test(String(incumbentUEI || '').trim().toUpperCase())
  if (!hasValidUEI) return null

  const exitDate = entityData?.eightA?.exitDate
  if (!exitDate) {
    if (loading) return <div className={`${styles.eightACallout} ${styles.eightALoading}`}>Checking 8(a) status…</div>
    if (!entityData && !error) return null

    const sbaLink = sbaProfileUrl(entityData, incumbentUEI)
    if (error) {
      return (
        <div className={`${styles.eightACallout} ${styles.eightANeutral}`} title={error}>
          <span>8(a) status unavailable. <a href={sbaLink} target="_blank" rel="noreferrer">Verify on SBA</a></span>
        </div>
      )
    }

    const statusText = entityData?.eightA
      ? 'An 8(a) exit date was not returned.'
      : 'No active 8(a) certification was returned. The entity may have exited the program or may not be a small business.'
    return (
      <div className={`${styles.eightACallout} ${styles.eightANeutral}`}>
        <span>{statusText}</span>
        <span className={styles.eightASource}>Source: SBA Entity Management API · <a href={sbaLink} target="_blank" rel="noreferrer">Verify on SBA</a></span>
      </div>
    )
  }

  const exit = localDate(exitDate)
  if (Number.isNaN(exit.getTime())) return null
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const sixMonthsFromNow = new Date(today)
  sixMonthsFromNow.setMonth(sixMonthsFromNow.getMonth() + 6)
  const contractEnd = localDate(contractEndDate)
  const exited = exit < today
  const exitsBeforeContractEnd = !exited && !Number.isNaN(contractEnd.getTime()) && exit < contractEnd
  const tone = exited ? styles.eightAGreen : exit <= sixMonthsFromNow ? styles.eightAAmber : styles.eightARed
  const sbaLink = sbaProfileUrl(entityData, incumbentUEI)

  return (
    <div className={`${styles.eightACallout} ${tone}`}>
      <span>8(a) exit: <strong>{formatDate(dateOnly(exitDate))}</strong></span>
      {exited ? <strong>Past exit date. Verify on SBA</strong> : exitsBeforeContractEnd ? <strong>Exits before contract end</strong> : null}
      <span className={styles.eightASource}>Source: SBA Entity Management API · <a href={sbaLink} target="_blank" rel="noreferrer">Verify on SBA</a></span>
      <button type="button" className={styles.eightAAddNote} onClick={onAddNote} disabled={addingNote || noteAdded}>
        {noteAdded ? 'Added' : addingNote ? 'Adding…' : 'Add as note'}
      </button>
    </div>
  )
}

function IncumbentPartnerCallout({ match, onOpenPartner }) {
  if (!match) return null
  return (
    <button
      type="button"
      className={styles.partnerCallout}
      onClick={onOpenPartner}
      title={`Open ${match.partner['Partner Name']} in Partners`}
    >
      <span><strong>Incumbent is a TAG partner:</strong> {match.partner['Partner Name']}</span>
      <span className={styles.partnerCalloutMeta}>Matched by exact UEI · View partner</span>
    </button>
  )
}

function fmtValue(v) {
  const input = String(v ?? '').trim()
  const absolute = parseFloat(input.replace(/[^0-9.]/g, ''))
  if (!absolute) return null
  const sign = /^\s*-/.test(input) || /^\s*\(/.test(input) ? '-' : ''
  if (absolute >= 1_000_000_000) return `${sign}$${(absolute / 1_000_000_000).toFixed(2)}B`
  if (absolute >= 1_000_000) return `${sign}$${(absolute / 1_000_000).toFixed(1)}M`
  if (absolute >= 1_000) return `${sign}$${(absolute / 1_000).toFixed(0)}K`
  return `${sign}$${absolute.toFixed(0)}`
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

const Field = (props) => <OpportunityField {...props} formatValue={formatFieldValue} />

function SummaryGroup({ title, items }) {
  const visible = items.filter((item) => item.showWhenEmpty || (
    item.value !== null && item.value !== undefined && String(item.value).trim() !== ''
  ))
  if (!visible.length) return null
  return (
    <div className={styles.summaryGroup}>
      <div className={styles.summaryGroupTitle}>{title}</div>
      <dl className={styles.summaryGrid}>
        {visible.map((item) => <div key={item.label} className={styles.summaryField}>
          <dt>{item.label}</dt>
          <dd>{item.display ?? (item.raw ? String(item.value) : formatFieldValue(item.value))}</dd>
        </div>)}
      </dl>
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
  const returnTo = opportunityReturnPath(searchParams.get('returnTo'))
  const navigate  = useNavigate()
  const { user }  = useAuth()

  const { allPipeline, loading: pipelineLoading, add: addPipelineOpp, update: updateOpp, remove: archiveOpp, restore: restoreOpp } = usePipeline()
  const { notes, loading: notesLoading, add: addNote, update: updateNote, remove: removeNote } = useNotes(decodedCN)
  const { tasks, add: addTask, update: updateTask, remove: removeTask, refreshContext } = useTasks(decodedCN)
  const { contacts, add: addContactRecord }  = useContacts()
  const { partners } = usePartners()
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
  const [noteUploadProgress, setNoteUploadProgress] = useState(null)
  const addingNoteRef = useRef(false)
  const [deletingNoteId,  setDeletingNoteId]  = useState(null)
  const [editingNoteId,   setEditingNoteId]   = useState(null)
  const [noteDraft,       setNoteDraft]       = useState('')
  const [savingNoteId,    setSavingNoteId]    = useState(null)
  const [showAddTask,     setShowAddTask]     = useState(false)
  const [editingTask,     setEditingTask]     = useState(null)
  const [deleteTaskTarget, setDeleteTaskTarget] = useState(null)
  const [deletingTaskId,  setDeletingTaskId]  = useState(null)
  const [savingTask,      setSavingTask]      = useState(false)
  const creatingTaskRef = useRef(false)
  const [updatingTaskId,  setUpdatingTaskId]  = useState(null)
  const [taskForm,        setTaskForm]        = useState({
    Title: '', Description: '', AssignedTo: '', DueDate: '', Priority: 'Medium', Status: 'To Do',
  })
  const [contactSearch,   setContactSearch]   = useState('')
  const [linkingContactId, setLinkingContactId] = useState(null)
  const linkingContactIdsRef = useRef(new Set())
  const [showNewContact,  setShowNewContact]  = useState(false)
  const [savingContact,   setSavingContact]   = useState(false)
  const creatingContactRef = useRef(false)
  const [newContactForm,  setNewContactForm]  = useState({
    Name: '', Title: '', Agency: '', Organization: '', Offices: '', Email: '', Phone: '', Notes: '', Type: 'Government',
  })
  const [hideDoneTasks, setHideDoneTasks] = useState(true)
  const [pendingRfiSave, setPendingRfiSave] = useState(null)
  const [pendingRenameSave, setPendingRenameSave] = useState(null)
  const [renamePreview, setRenamePreview] = useState(null)
  const [renameProgress, setRenameProgress] = useState('')
  const [addingEightANote, setAddingEightANote] = useState(false)
  const [eightANoteAdded, setEightANoteAdded] = useState(false)
  const [applyingSAMUpdate, setApplyingSAMUpdate] = useState(false)
  const [editingLinks, setEditingLinks] = useState(false)
  const [savingLinks, setSavingLinks] = useState(false)
  const [linkDraft, setLinkDraft] = useState(null)
  const [outlineCollapsed, setOutlineCollapsed] = useState(true)
  const opportunityEditRef = useRef(null)
  const linksEditRef = useRef(null)
  const taskEditRef = useRef(null)
  const contactEditRef = useRef(null)
  const opportunitySaveActionRef = useRef(null)
  const linksSaveActionRef = useRef(null)
  const taskSaveActionRef = useRef(null)
  const contactSaveActionRef = useRef(null)
  

  const opp = useMemo(
    () => {
      const byRow = routeRowIndex !== null
        ? allPipeline.find((o) => o._rowIndex === routeRowIndex)
        : null
      return byRow || allPipeline.find((o) =>
        normalizeOpportunityKey(o[C.contractNum]) === normalizeOpportunityKey(decodedCN)
      )
    },
    [allPipeline, decodedCN, routeRowIndex]
  )
  const archived = /^(yes|true|1)$/i.test(String(opp?.Archived || '').trim())

  const incumbentEightA = useEntityEightA(opp?.[C.incumbentUEI])
  const rfiFollowUpMonitor = useRfiFollowUpMonitor(opp ? [opp] : [], contacts)
  const samChangeSuggestion = useSAMChangeSuggestion(opp, C)
  const opportunityAlerts = useOpportunityAlerts(decodedCN)
  const followUpPanelRef = useRef(null)
  const focusFollowUps = searchParams.get('focus') === 'follow-ups'

  useEffect(() => {
    setEightANoteAdded(false)
  }, [decodedCN, incumbentEightA.data?.eightA?.exitDate])


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

  const incumbentPartnerMatch = useMemo(
    () => findIncumbentPartner(opp?.[C.incumbentUEI], partners),
    [opp, partners]
  )

  const relatedContactGroups = useMemo(() => {
    if (!opp) return { opportunityOffice: [], linkedContactOffice: [] }

    const opportunityAgency = normalizeContactMatchText(opp[C.agency])
    const opportunityOffice = String(opp[C.office] || '').trim()
    const linkedKeys = new Set(linkedContacts.map(contactKey))
    const linkedNames = new Set(linkedContacts.map((contact) => normalizeContactMatchText(contact.Name)))
    const isAlreadyLinked = (contact) => linkedKeys.has(contactKey(contact)) || linkedNames.has(normalizeContactMatchText(contact.Name))
    const sameAgency = (contact, agency) =>
      Boolean(agency) && normalizeContactMatchText(contact.Agency) === agency

    const opportunityOfficeMatches = opportunityAgency && opportunityOffice
      ? contacts.flatMap((contact) => {
          if (isAlreadyLinked(contact) || !sameAgency(contact, opportunityAgency)) return []
          const matchingOffice = officeValues(contact.Offices).find((office) => officeMatch(office, opportunityOffice))
          return matchingOffice ? [{ contact, matchedOffice: matchingOffice, reason: `Matches this opportunity's office: ${matchingOffice}` }] : []
        })
      : []

    const opportunityMatchKeys = new Set(opportunityOfficeMatches.map(({ contact }) => contactKey(contact)))
    const linkedContactOfficeMatches = contacts.flatMap((candidate) => {
      if (isAlreadyLinked(candidate) || opportunityMatchKeys.has(contactKey(candidate))) return []
      const candidateAgency = normalizeContactMatchText(candidate.Agency)
      if (!candidateAgency) return []

      for (const linkedContact of linkedContacts) {
        const linkedAgency = normalizeContactMatchText(linkedContact.Agency)
        if (!linkedAgency || linkedAgency !== candidateAgency) continue
        for (const linkedOffice of officeValues(linkedContact.Offices)) {
          const matchingOffice = officeValues(candidate.Offices).find((office) => officeMatch(office, linkedOffice))
          if (matchingOffice) {
            return [{
              contact: candidate,
              matchedOffice: matchingOffice,
              reason: `Similar office to linked contact ${linkedContact.Name}: ${matchingOffice}`,
            }]
          }
        }
      }
      return []
    })

    return {
      opportunityOffice: opportunityOfficeMatches,
      linkedContactOffice: linkedContactOfficeMatches,
    }
  }, [opp, contacts, linkedContacts])

  const unlinkedContacts = useMemo(() => {
    const linked = new Set(linkedContacts.map((c) => c.Name))
    const q = contactSearch.trim().toLowerCase()
    if (!q) return []
    return contacts.filter((c) => {
      if (linked.has(c.Name)) return false
      return [c.Name, c.Agency, c.Email].some((v) => v?.toLowerCase().includes(q))
    }).slice(0, 20)
  }, [contacts, linkedContacts, contactSearch])

  const relatedOpportunities = useMemo(
    () => notes.map((n) => parseRelatedOpportunityNote(n.NoteText)).filter(Boolean),
    [notes]
  )
  const visibleNotes = useMemo(
    () => notes.filter((n) => !parseRelatedOpportunityNote(n.NoteText)),
    [notes]
  )
  const peopleSearchContext = useMemo(() => {
    if (!opp) return {}
    return {
      notes: visibleNotes.map((note) => ({
        date: note.CreatedDate || note.Date || '',
        author: note.Author || '',
        text: String(note.NoteText || ''),
      })),
    }
  }, [opp, visibleNotes])

  const saveFollowUpDecision = async (candidate, decision) => {
    await saveRFIFollowUpDecision({
      'Opportunity ID': opp[C.contractNum],
      'Follow-up Notice ID': candidate.noticeId || '',
      'Follow-up Solicitation Number': candidate.solicitationNumber || '',
      Decision: decision,
      'Candidate Title': candidate.title || '',
    })
    await rfiFollowUpMonitor.synchronize({ forceReplace: false })
    await rfiFollowUpMonitor.loadStatus()
  }

  const saveFollowUpOverride = async (opportunityId, values) => {
    await saveRFIFollowUpOverride(opportunityId, values)
    await rfiFollowUpMonitor.synchronize({ forceReplace: false })
    await rfiFollowUpMonitor.loadStatus()
  }

  const handleAddEightANote = async () => {
    const exitDate = incumbentEightA.data?.eightA?.exitDate
    if (!exitDate || addingEightANote) return
    const note = `The 8(a) Exit Date of the incumbent is ${dateOnly(exitDate)}`
    if (notes.some((item) => String(item.NoteText || '') === note)) {
      setEightANoteAdded(true)
      toast?.success('8(a) exit note is already attached')
      return
    }
    setAddingEightANote(true)
    try {
      await addNote(user.firstName, note)
      setEightANoteAdded(true)
      toast?.success('8(a) exit date added as a note')
    } catch (error) {
      toast?.error(`Failed to add note: ${error.message}`)
    } finally {
      setAddingEightANote(false)
    }
  }

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

  useSaveShortcut({
    enabled: editing && !saving,
    label: 'these opportunity changes',
    onSave: () => opportunitySaveActionRef.current?.(),
    scopeRef: opportunityEditRef,
  })
  useSaveShortcut({
    enabled: editingLinks && !savingLinks,
    label: 'these opportunity links',
    onSave: () => linksSaveActionRef.current?.(),
    scopeRef: linksEditRef,
  })
  useSaveShortcut({
    enabled: showAddTask && !savingTask,
    label: editingTask ? 'these task changes' : 'this new task',
    onSave: () => taskSaveActionRef.current?.(),
    scopeRef: taskEditRef,
  })
  useSaveShortcut({
    enabled: showNewContact && !savingContact,
    label: 'this new linked contact',
    onSave: () => contactSaveActionRef.current?.(),
    scopeRef: contactEditRef,
  })

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
        <button className="btn btn-ghost" onClick={() => navigate(returnTo)}>← Back</button>
        <p className="text-muted mt-3">Opportunity not found.</p>
      </div>
    )
  }

  // ── Helpers that depend on opp (safe below early returns) ─────────────
  const cur = form || opp

  const f = (key) => cur[key]
  const set = (key) => (val) => setForm((prev) => ({ ...prev, [key]: val }))
  const isResponseRecord = isResponseOpportunity(cur, C)
  const hasFollowOnMatcher = isFollowOnSourceOpportunity(cur, C)
  const noticeType = normalizeNoticeType(f(C.noticeType))
  const noticeTypeBadgeClass = noticeType === 'MRAS'
    ? 'badge-qualify'
    : noticeType === 'RFI'
      ? 'badge-tracking'
      : 'badge-proposal'
  const submissionDateLabel = noticeType === 'MRAS'
    ? 'MRAS submission date'
    : noticeType === 'RFI'
      ? 'RFI submission date'
      : noticeType
        ? `${noticeType} response or submission date`
        : 'Response or submission date'
  const hasIncumbentHistory = /^[A-Z0-9]{12}$/.test(String(opp[C.incumbentUEI] || '').trim().toUpperCase())
  const sectionGroups = [
    ['Overview', [['Summary', 'overview-summary'], ['Contacts', 'overview-contacts'], ['Partners & links', 'overview-links'], ['Files', 'overview-files']]],
    ['Activity', [['Notes', 'activity-notes'], ['Tasks', 'activity-tasks']]],
    ['Research', [
      ...(hasIncumbentHistory ? [['Incumbent history', 'research-incumbent']] : []),
      ['Award lookup', 'research-awards'],
      ['Find contacts', 'research-contacts'],
    ]],
    ['Follow-up', [
      ['Follow-up emails', 'followup-email'],
      ...(hasFollowOnMatcher ? [[`${noticeType || 'RFI'} matcher`, 'followup-rfi']] : []),
    ]],
  ]
  const hasSubmissionDate = !Number.isNaN(localDate(f(C.submDate)).getTime())
  const linkedContractNumbers = new Set(relatedOpportunities.map((related) => related.contractNumber))
  const followUpStatus = rfiFollowUpMonitor.statusByOpportunity[normalizeOpportunityKey(opp[C.contractNum])]

  const handleEdit   = () => { setForm({ ...opp }); setEditing(true) }
  const handleCancel = () => { setForm(null); setEditing(false) }

  const beginLinkEdit = () => {
    setLinkDraft({
      [C.govwin]: opp[C.govwin] || '',
      [C.folder]: opp[C.folder] || '',
      [C.slideDeck]: opp[C.slideDeck] || '',
      other: cleanLinks(opp[C.otherLinks]).map(parseNamedLink),
    })
    setEditingLinks(true)
  }

  const saveLinks = async () => {
    if (!linkDraft || savingLinks) return
    setSavingLinks(true)
    try {
      const patch = {
        [C.govwin]: linkDraft[C.govwin] || '',
        [C.folder]: linkDraft[C.folder] || '',
        [C.slideDeck]: linkDraft[C.slideDeck] || '',
        [C.otherLinks]: joinLinks(linkDraft.other.map(({ label, url }) => namedLinkLine(label, url)).filter(Boolean)),
      }
      await updateOpp(opp._rowIndex, patch, opp)
      setForm((current) => current ? { ...current, ...patch } : current)
      setEditingLinks(false)
      setLinkDraft(null)
      toast?.success('Links updated')
    } catch (error) {
      toast?.error(`Could not update links: ${error.message}`)
    } finally {
      setSavingLinks(false)
    }
  }

  const handleApplySAMUpdate = async () => {
    const patch = samChangeSuggestion.suggestion?.patch
    if (!patch || Object.keys(patch).length === 0 || applyingSAMUpdate) return
    setApplyingSAMUpdate(true)
    try {
      await updateOpp(opp._rowIndex, patch, opp)
      await samChangeSuggestion.markReviewed()
      toast?.success('Pipeline updated with the latest SAM.gov information')
    } catch (error) {
      toast?.error(`SAM update failed: ${error.message}`)
    } finally {
      setApplyingSAMUpdate(false)
    }
  }

  const handleKeepCurrentSAMValues = async () => {
    if (applyingSAMUpdate) return
    setApplyingSAMUpdate(true)
    try {
      await samChangeSuggestion.markReviewed()
      toast?.success('Current pipeline values kept')
    } catch (error) {
      toast?.error(error.message)
    } finally {
      setApplyingSAMUpdate(false)
    }
  }

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
      const changedTables = ['PipelineTable', 'TasksTable', 'NotesTable', 'EmailFollowUpDraftsTable']
      await publishCacheUpdate(changedTables)
      verifyCacheInBackground(changedTables)
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
        const detailParams = new URLSearchParams({ row: String(opp._rowIndex) })
        if (returnTo !== '/opportunities') detailParams.set('returnTo', returnTo)
        navigate(`/opportunities/${encodeURIComponent(newIdentifier)}?${detailParams.toString()}`, { replace: true })
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
    const needsActivityPrompt = needsRfiActivityPhasePrompt(opp, cleanedForm, {
      noticeType: C.noticeType,
      submissionDate: C.submDate,
      activityPhase: C.actPhase,
    })

    if (needsActivityPrompt) {
      setPendingRfiSave(cleanedForm)
      return
    }
    return prepareOpportunitySave(cleanedForm)
  }

  const handleDeleteOpportunity = async () => {
    setDeleting(true)
    try {
      await archiveOpp(opp._rowIndex)
      toast?.success('Opportunity archived')
      navigate('/opportunities?tab=All&archived=1')
    } catch (err) {
      toast?.error(`Failed to delete: ${err.message}`)
      setDeleting(false)
      setConfirmDelete(false)
    }
  }

  const handleToggleFlag = async () => {
    if (!opp || saving) return
    setSaving(true)
    try {
      const nextFlagged = !isSAMOpportunityFlagged(opp[C.flagged])
      await updateOpp(opp._rowIndex, { [C.flagged]: nextFlagged ? 'Yes' : '' })
      toast?.success(nextFlagged ? 'Opportunity flagged for the team' : 'Team flag removed')
    } catch (err) {
      toast?.error(`Could not update flag: ${err.message}`)
    } finally {
      setSaving(false)
    }
  }

  const handleAddNote = async (attachments = []) => {
    const files = Array.from(attachments || [])
    if (addingNoteRef.current || (!newNote.trim() && files.length === 0)) return false
    addingNoteRef.current = true
    setAddingNote(true)
    let uploaded = []
    try {
      uploaded = files.length
        ? await uploadOpportunityReferenceFiles(decodedCN, files, setNoteUploadProgress)
        : []
      const noteText = noteWithReferenceLinks(newNote, uploaded)
      await addNote(user.firstName, noteText)
      setNewNote('')
      if (uploaded.length) announceOpportunityFilesChanged(decodedCN)
      toast?.success('Note added')
      return true
    } catch (err) {
      if (uploaded.length) await rollbackOpportunityReferenceFiles(decodedCN, uploaded).catch(() => {})
      toast?.error(`Failed to add note: ${err.message}`)
      return false
    } finally {
      addingNoteRef.current = false
      setAddingNote(false)
      setNoteUploadProgress(null)
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

  const startEditNote = (note) => {
    if (note._temp || note._rowIndex === undefined) return
    setEditingNoteId(note._rowIndex)
    setNoteDraft(note.NoteText || '')
  }

  const handleSaveNote = async (note) => {
    const text = noteDraft.trim()
    if (!text || savingNoteId !== null) return
    setSavingNoteId(note._rowIndex)
    try {
      await updateNote(note._rowIndex, { NoteText: text }, note)
      setEditingNoteId(null)
      setNoteDraft('')
      toast?.success('Note updated')
    } catch (err) {
      toast?.error(`Failed to update note: ${err.message}`)
    } finally {
      setSavingNoteId(null)
    }
  }

  const openContactPanel = (contactRecord) => {
    const contactId = String(contactRecord?.ContactID ?? contactRecord?._rowIndex ?? '').trim()
    if (!contactId) return
    navigate(`/contacts?contactId=${encodeURIComponent(contactId)}`)
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
    const key = contactKey(c)
    if (!key || linkingContactIdsRef.current.has(key)) return
    linkingContactIdsRef.current.add(key)
    setLinkingContactId(key)
    setContactSearch('')
    try {
      const nextPOC = addPOCName(opp[C.poc], c.Name)
      await retryIdempotent(() => updateOpp(opp._rowIndex, { [C.poc]: nextPOC }, opp))
      setForm((prev) => prev ? { ...prev, [C.poc]: nextPOC } : prev)
      toast?.success(`${c.Name} linked`)
    } catch (err) {
      toast?.error(`Failed to link ${c.Name}: ${err.message}`)
    } finally {
      linkingContactIdsRef.current.delete(key)
      setLinkingContactId((current) => current === key ? null : current)
    }
  }

  const handleUnlinkContact = async (c) => {
    const key = contactKey(c)
    if (!key || linkingContactIdsRef.current.has(key)) return
    linkingContactIdsRef.current.add(key)
    setLinkingContactId(key)
    try {
      const nextPOC = parsePOCNames(opp[C.poc]).filter((name) => name !== c.Name).join(', ')
      await retryIdempotent(() => updateOpp(opp._rowIndex, { [C.poc]: nextPOC }, opp))
      setForm((prev) => prev ? { ...prev, [C.poc]: nextPOC } : prev)
      toast?.success(`${c.Name} unlinked`)
    } catch (err) {
      toast?.error(`Failed to unlink ${c.Name}: ${err.message}`)
    } finally {
      linkingContactIdsRef.current.delete(key)
      setLinkingContactId((current) => current === key ? null : current)
    }
  }

  const createContactOnly = async (contactData) => {
    const name = String(contactData?.Name || '').trim()
    if (!name) throw new Error('Name is required')
    if (creatingContactRef.current) throw new Error('A contact is already being added')
    creatingContactRef.current = true
    setSavingContact(true)
    try {
      return await addContactRecord({ ...contactData, Name: name })
    } finally {
      creatingContactRef.current = false
      setSavingContact(false)
    }
  }

  const createAndLinkContact = async (contactData, { quiet = false } = {}) => {
    const name = String(contactData?.Name || '').trim()
    if (!name) throw new Error('Name is required')
    if (creatingContactRef.current) throw new Error('A contact is already being added')
    creatingContactRef.current = true
    setSavingContact(true)
    let creation
    try {
      creation = await addContactRecord({ ...contactData, Name: name })
      const nextPOC = addPOCName(opp[C.poc], name)
      await retryIdempotent(() => updateOpp(opp._rowIndex, { [C.poc]: nextPOC }, opp))
      setForm((prev) => prev ? { ...prev, [C.poc]: nextPOC } : prev)
      if (!quiet) toast?.success(`${name} added and linked`)
      return { ...creation, name, nextPOC, linked: true }
    } catch (err) {
      if (creation?.contact) {
        if (!quiet) {
          toast?.success(`${name} was added to Contacts`)
          toast?.error(`The contact could not be linked: ${err.message}`)
        }
        return { ...creation, name, linked: false, linkError: err }
      }
      if (!quiet) toast?.error(`Failed to add contact: ${err.message}`)
      throw err
    } finally {
      creatingContactRef.current = false
      setSavingContact(false)
    }
  }

  const handleCreateAndLinkContact = async () => {
    try {
      const outcome = await createAndLinkContact(newContactForm)
      setShowNewContact(false)
      setNewContactForm({ Name: '', Title: '', Agency: '', Organization: '', Offices: '', Email: '', Phone: '', Notes: '', Type: 'Government' })
      if (outcome?.linked === false) return
    } catch {
      // createAndLinkContact already surfaced a useful error.
    }
  }

  const continuePeopleSearch = (searchState) => {
    navigate('/lookup?view=people', {
      state: {
        peopleSearch: {
          ...searchState,
          scopeLabel: `${opp[C.title] || 'Opportunity'} (${opp[C.contractNum] || decodedCN})`,
          context: peopleSearchContext,
        },
      },
    })
  }

  const handleAddFollowOn = async (candidate) => {
    const contractNumber = candidate.solicitationNumber || candidate.noticeId
    if (!contractNumber) throw new Error('The follow-on notice has no solicitation or notice ID')

    const source = { contractNumber: opp[C.contractNum], title: opp[C.title] }
    const existing = allPipeline.find((item) => item[C.contractNum] === contractNumber)
    if (existing) {
      await linkRelatedOpportunities(source, { contractNumber, title: existing[C.title] })
      await invalidateCache(['PipelineTable', 'ContactsTable'])
      toast?.success(`Existing follow-on linked to this ${noticeType || 'opportunity'}`)
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
      [C.noticeType]: candidate.noticeType || '',
      [C.poc]: contactName,
      [C.submDate]: candidate.responseDate || '',
      [C.otherLinks]: candidate.samLink || '',
    })
    await linkRelatedOpportunities(source, { contractNumber, title: candidate.title || '' })
    await invalidateCache(['PipelineTable', 'ContactsTable'])
    toast?.success(`Follow-on added and linked to this ${noticeType || 'opportunity'}`)
  }

  const openAddTask = () => {
    setEditingTask(null)
    setTaskForm({ Title: '', Description: '', AssignedTo: '', DueDate: '', Priority: 'Medium', Status: 'To Do' })
    setShowAddTask(true)
  }

  const openEditTask = (task) => {
    setEditingTask(task)
    setTaskForm({
      Title: task.Title || '',
      Description: task.Description || '',
      AssignedTo: task.AssignedTo || '',
      DueDate: dateOnly(task.DueDate) || '',
      Priority: task.Priority || 'Medium',
      Status: task.Status || 'To Do',
    })
    setShowAddTask(true)
  }

  const handleDeleteTask = async () => {
    if (!deleteTaskTarget || deletingTaskId) return
    setDeletingTaskId(deleteTaskTarget.TaskID)
    try {
      await removeTask(deleteTaskTarget._rowIndex)
      toast?.success('Task deleted')
      setDeleteTaskTarget(null)
    } catch (error) {
      toast?.error(`Failed to delete task: ${error.message}`)
    } finally {
      setDeletingTaskId(null)
    }
  }

  const submitTask = async () => {
    if (creatingTaskRef.current) return
    if (!taskForm.Title.trim()) {
      toast?.error('Enter a task title')
      return
    }

    creatingTaskRef.current = true
    setSavingTask(true)
    try {
      if (editingTask) {
        await updateTask(editingTask._rowIndex, {
          Title: taskForm.Title.trim(),
          Description: taskForm.Description,
          AssignedTo: taskForm.AssignedTo,
          DueDate: taskForm.DueDate || '',
          Priority: taskForm.Priority,
          Status: taskForm.Status,
        })
      } else {
        await addTask({
          ContractNumber: decodedCN,
          ContractTitle:  opp[C.title],
          ...taskForm,
          DueDate: taskForm.DueDate || '',
        }, user.displayName)
      }
      setShowAddTask(false)
      setEditingTask(null)
      setTaskForm({ Title: '', Description: '', AssignedTo: '', DueDate: '', Priority: 'Medium', Status: 'To Do' })
      toast?.success(editingTask ? 'Task updated' : 'Task created')
    } catch (err) {
      toast?.error(`Failed to ${editingTask ? 'update' : 'add'} task: ${err.message}`)
    } finally {
      creatingTaskRef.current = false
      setSavingTask(false)
    }
  }

  opportunitySaveActionRef.current = handleSave
  linksSaveActionRef.current = saveLinks
  taskSaveActionRef.current = submitTask
  contactSaveActionRef.current = handleCreateAndLinkContact

  const valueFormatted = fmtValue(opp[C.value])
  const fileAlert = opportunityAlerts.byType.ebuy_files?.badgeVisible
    ? opportunityAlerts.byType.ebuy_files
    : opportunityAlerts.byType.sam_files?.badgeVisible
      ? opportunityAlerts.byType.sam_files
      : null
  const fileAlertChanges = fileAlert?.details?.files || fileAlert?.details?.changedFiles || []
  const fileAlertLabel = fileAlertChanges.length && fileAlertChanges.every((file) => file.change === 'added')
    ? 'New files'
    : 'Files updated'

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
        rightContent={<div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          {followUpStatus?.badgeVisible && <button className="badge" style={{ background: followUpStatus.badgeState === 'seen' ? 'var(--gray-100)' : 'var(--blue-50)', border: `0.5px solid ${followUpStatus.badgeState === 'seen' ? 'var(--gray-300)' : 'var(--blue-200)'}`, color: followUpStatus.badgeState === 'seen' ? 'var(--gray-600)' : 'var(--blue-800)', cursor: 'pointer' }} onClick={() => { rfiFollowUpMonitor.markSeen(opp[C.contractNum]).catch(() => {}); const next = new URLSearchParams(searchParams); next.set('focus', 'follow-ups'); navigate({ search: `?${next.toString()}` }, { replace: true }) }} title={`${followUpStatus.pendingCount} possible follow-on${followUpStatus.pendingCount === 1 ? '' : 's'}`}>
            {followUpStatus.badgeState === 'seen' ? 'Follow-ons reviewed' : `${followUpStatus.pendingCount} possible follow-on${followUpStatus.pendingCount === 1 ? '' : 's'}`}
          </button>}
          {samChangeSuggestion.suggestion && <span className="badge badge-qualify">SAM update available</span>}
          {fileAlert && <button
            className="badge badge-qualify"
            style={{ cursor: 'pointer' }}
            onClick={() => {
              opportunityAlerts.acknowledge(fileAlert.type, fileAlert.fingerprint).catch(() => {})
              navigate(`/opportunities/${encodeURIComponent(decodedCN)}/dossier?focus=files&alert=${encodeURIComponent(fileAlert.type)}`)
            }}
            title={fileAlert.summary}
          >{fileAlertLabel}</button>}
          {contractLifecycleAlert && <span className={`badge ${contractLifecycleBadgeClass}`} title={contractLifecycleTooltip}>{contractLifecycleAlert.reason}</span>}
          {incumbentPartnerMatch && <span className={styles.partnerBadge} title={`Exact UEI match to TAG partner ${incumbentPartnerMatch.partner['Partner Name']}`}>Incumbent is a TAG partner</span>}
        </div>}
      />

      <div className="page-body">
        <button className="btn btn-ghost text-sm" style={{ marginBottom: 14 }}
          onClick={() => navigate(returnTo)}>
          ← Opportunities
        </button>

        {archived && <div className={styles.archivedNotice}>
          <span><strong>Archived opportunity</strong><small>Read-only · notes, tasks, drafts, and SharePoint files are retained.</small></span>
          <button className="btn btn-primary" onClick={async () => {
            try { await restoreOpp(opp._rowIndex); toast?.success('Opportunity restored'); navigate(`/opportunities/${encodeURIComponent(decodedCN)}?row=${opp._rowIndex}`, { replace: true }) }
            catch (error) { toast?.error(`Could not restore: ${error.message}`) }
          }}>Restore</button>
        </div>}

        <SAMChangeSuggestion
          suggestion={samChangeSuggestion.suggestion}
          applying={applyingSAMUpdate}
          onApply={handleApplySAMUpdate}
          onKeepCurrent={handleKeepCurrentSAMValues}
        />

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
                    <select
                      className={styles.badgeSelect}
                      value={f(C.noticeType) || ''}
                      onChange={(e) => set(C.noticeType)(e.target.value)}
                      aria-label="Notice type"
                    >
                      <option value="">Notice type</option>
                      {NOTICE_TYPE_VALUES.map((type) => <option key={type}>{type}</option>)}
                    </select>
                  </>
                )
                : (
                  <>
                    <span className={`badge ${PHASE_BADGE[opp[C.phase]] || 'badge-tracking'}`}>{opp[C.phase]}</span>
                    {opp[C.outlook] && <span className="badge badge-tracking">{opp[C.outlook]}</span>}
                    {noticeType && <span className={`badge ${noticeTypeBadgeClass}`}>{noticeType}</span>}
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
                <label className="form-label" style={{ marginBottom: 0, whiteSpace: 'nowrap' }}>Assigned to</label>
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
                    className="btn"
                    onClick={() => navigate(`/opportunities/${encodeURIComponent(decodedCN)}/dossier`)}
                    title="Open the consolidated opportunity dossier"
                  >Open dossier</button>
                  {!archived && <button
                    className={`btn ${isSAMOpportunityFlagged(opp?.[C.flagged]) ? styles.flagActive : ''}`}
                    onClick={handleToggleFlag}
                    disabled={saving}
                    aria-pressed={isSAMOpportunityFlagged(opp?.[C.flagged])}
                    title={isSAMOpportunityFlagged(opp?.[C.flagged]) ? 'Remove team flag' : 'Flag for the team'}
                  >⚑ {isSAMOpportunityFlagged(opp?.[C.flagged]) ? 'Flagged' : 'Flag'}</button>}
                  <button
                    className="btn btn-ghost"
                    style={{ fontSize: 12, color: 'var(--blue-600)' }}
                    onClick={() => navigate(`/ai-chat?opportunity=${encodeURIComponent(decodedCN)}`)}
                    title="Discuss this opportunity with AI"
                  >✦ Discuss with AI</button>
                  {!archived && <button className="btn" onClick={handleEdit}><ActionIcon name="edit" /> Edit</button>}
                  {!archived && <button
                    className="btn btn-ghost"
                    style={{ fontSize: 12, color: 'var(--red-600)' }}
                    onClick={() => setConfirmDelete(true)}
                    title="Delete this opportunity"
                  ><ActionIcon name="delete" /> Archive</button>}
                </>
              )
              : (
                <>
                  <button className="btn btn-ghost" onClick={handleCancel} disabled={saving}>Cancel</button>
                  <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
                    {saving ? 'Saving…' : 'Save changes'}
                  </button>
                </>
              )
            }
          </div>
        </div>

        <label className={styles.detailJump}>
          <span>Jump to section</span>
          <select className="form-input" defaultValue="" onChange={(event) => { if (event.target.value) document.getElementById(event.target.value)?.scrollIntoView({ behavior: 'smooth', block: 'start' }) }}>
            <option value="" disabled>Select a section</option>
            {sectionGroups.flatMap(([group, items]) => items.map(([label, id]) => <option value={id} key={id}>{group} · {label}</option>))}
          </select>
        </label>
        <div className={`${styles.detailLayout} ${outlineCollapsed ? styles.detailLayoutCollapsed : ''}`}>
          <aside className={`${styles.detailOutline} ${outlineCollapsed ? styles.detailOutlineCollapsed : ''}`} aria-label="Opportunity sections">
            <div className={styles.outlineHeader}>
              {!outlineCollapsed && <div className={styles.outlineHeading}>On this page</div>}
              <button
                type="button"
                className={styles.outlineToggle}
                onClick={() => setOutlineCollapsed((value) => !value)}
                aria-label={outlineCollapsed ? 'Open page navigator' : 'Close page navigator'}
                title={outlineCollapsed ? 'Open page navigator' : 'Close page navigator'}
              >{outlineCollapsed ? '›' : '‹'}</button>
            </div>
            {!outlineCollapsed && sectionGroups.map(([group, items]) => <div className={styles.outlineGroup} key={group}><strong>{group}</strong>{items.map(([label, id]) => <button type="button" key={id} onClick={() => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>{label}</button>)}</div>)}
          </aside>
          <main className={styles.detailContent}>
        <div className={`${styles.categoryHeading} ${styles.categoryOverview}`}>Overview</div>
        <Section title="Opportunity summary" id="overview-summary">
          {editing ? <div ref={opportunityEditRef} className={styles.summaryEditGroups}>
            <div className={styles.summaryEditGroup}><div className={styles.summaryGroupTitle}>Capture status</div><div className={styles.fieldGrid}>
              <Field label="Opportunity title" value={f(C.title)} editing onChange={set(C.title)} />
              <Field label="Contract or notice ID" value={f(C.contractNum)} editing onChange={set(C.contractNum)} raw />
              <Field label="Notice type" value={f(C.noticeType)} editing onChange={set(C.noticeType)} options={NOTICE_TYPE_VALUES} />
              <Field label="Activity phase" value={f(C.actPhase)} editing onChange={set(C.actPhase)} options={activityPhaseOptions} />
              <Field label="Pursuit priority" value={f(C.priority)} editing onChange={set(C.priority)} options={priorityOptions} />
              <Field label="Bid decision" value={f(C.bidNoBid)} editing onChange={set(C.bidNoBid)} options={bidNoBidOptions} />
              <Field label="Prime or sub" value={f(C.primeOrSub)} editing onChange={set(C.primeOrSub)} options={primeOrSubOptions} />
              <Field label="Partners" value={f(C.partner)} editing onChange={set(C.partner)} />
            </div></div>
            <div className={styles.summaryEditGroup}><div className={styles.summaryGroupTitle}>Customer and requirement</div><div className={styles.fieldGrid}>
              <Field label="Department" value={f(C.department)} editing onChange={set(C.department)} />
              <Field label="Agency" value={f(C.agency)} editing onChange={set(C.agency)} />
              <Field label="Office" value={f(C.office)} editing onChange={set(C.office)} />
              <Field label="Solicitation number" value={f(C.solNum)} editing onChange={set(C.solNum)} />
              <Field label="NAICS code" value={f(C.naics)} editing onChange={set(C.naics)} raw />
              <Field label="Set-aside" value={f(C.setAside)} editing onChange={set(C.setAside)} options={setAsideOptions} />
              <Field label="Contract vehicle" value={f(C.vehicle)} editing onChange={set(C.vehicle)} />
              <Field label="Contract vehicle number" value={f(C.vehicleNumber)} editing onChange={set(C.vehicleNumber)} />
              <Field label="Contract classification" value={f(C.classification)} editing onChange={set(C.classification)} />
              <Field label="Incumbent" value={f(C.incumbent)} editing onChange={set(C.incumbent)} />
              <Field label="Incumbent UEI" value={f(C.incumbentUEI)} editing onChange={set(C.incumbentUEI)} raw />
            </div></div>
            <div className={styles.summaryEditGroup}><div className={styles.summaryGroupTitle}>Dates and contract</div><div className={styles.fieldGrid}>
              {(isResponseRecord || hasSubmissionDate) && <Field label={submissionDateLabel} value={f(C.submDate)} editing onChange={set(C.submDate)} type="date" />}
              <Field label="Contract end date" value={f(C.endDate)} editing onChange={set(C.endDate)} type="date" />
              <Field label="Anticipated award date" value={f(C.awardDate)} editing onChange={set(C.awardDate)} type="date" />
              <Field label="Fiscal year" value={f(C.fiscalYear)} editing onChange={set(C.fiscalYear)} raw />
              <Field label="Total contract value ($)" value={f(C.value)} editing onChange={set(C.value)} type="number" />
              <Field label="Base year value ($)" value={f(C.baseValue)} editing onChange={set(C.baseValue)} type="number" />
            </div></div>
          </div> : <>
            <SummaryGroup title="Capture status" items={[
              { label: 'Opportunity phase', value: f(C.phase), raw: true }, { label: 'Activity phase', value: f(C.actPhase), raw: true },
              { label: 'Notice type', value: f(C.noticeType), raw: true },
              { label: 'Outlook', value: f(C.outlook), raw: true }, { label: 'Pursuit priority', value: f(C.priority), raw: true },
              { label: 'Bid decision', value: f(C.bidNoBid), raw: true }, { label: 'Assigned to', value: f(C.assignedTo), raw: true },
              { label: 'Prime or sub', value: f(C.primeOrSub), raw: true }, { label: 'Partners', value: f(C.partner), raw: true },
            ]} />
            <SummaryGroup title="Customer and requirement" items={[
              { label: 'Department', value: f(C.department), raw: true }, { label: 'Agency', value: f(C.agency), raw: true },
              { label: 'Office', value: f(C.office), raw: true }, { label: 'Solicitation number', value: f(C.solNum), raw: true },
              { label: 'NAICS code', value: f(C.naics), raw: true }, { label: 'Set-aside', value: f(C.setAside), raw: true },
              { label: 'Contract vehicle', value: f(C.vehicle), raw: true }, { label: 'Vehicle number', value: f(C.vehicleNumber), raw: true },
              { label: 'Contract classification', value: f(C.classification), raw: true }, { label: 'Incumbent', value: f(C.incumbent), raw: true },
              { label: 'Incumbent UEI', value: f(C.incumbentUEI), raw: true },
            ]} />
            <SummaryGroup title="Dates and contract" items={[
              {
                label: submissionDateLabel,
                value: (isResponseRecord || hasSubmissionDate) ? f(C.submDate) : '',
                display: formatDate(f(C.submDate)),
                showWhenEmpty: isResponseRecord,
              },
              { label: 'Contract end date', value: f(C.endDate), display: formatDate(f(C.endDate)) },
              { label: 'Anticipated award date', value: f(C.awardDate), display: formatDate(f(C.awardDate)) },
              { label: 'Fiscal year', value: f(C.fiscalYear), raw: true },
              { label: 'Total contract value', value: f(C.value), display: fmtValue(f(C.value)) },
              { label: 'Base year value', value: f(C.baseValue), display: fmtValue(f(C.baseValue)) },
              { label: 'Last modified', value: f(C.lastMod), display: formatDate(f(C.lastMod)) },
            ]} />
          </>}
          <div className={styles.summaryCallouts}>
            <EightAExitCallout entityData={incumbentEightA.data} incumbentUEI={f(C.incumbentUEI)} loading={incumbentEightA.loading} error={incumbentEightA.error} contractEndDate={f(C.endDate)} onAddNote={handleAddEightANote} addingNote={addingEightANote} noteAdded={eightANoteAdded} />
          </div>
        </Section>

        {/* ── Section 5: Contacts ── */}
        <Section title="Contacts" id="overview-contacts">
          {linkedContacts.length > 0
            ? linkedContacts.map((c) => (
                <div key={c.ContactID} className={styles.contactCard}>
                  <button type="button" className={styles.contactOpen} onClick={() => openContactPanel(c)} title={`Open ${c.Name || 'contact'}`}>
                    <span className={styles.contactAv}>
                      {c.Name?.split(' ').map((n) => n[0]).slice(0, 2).join('')}
                    </span>
                    <span className={styles.contactInfo}>
                      <span className={styles.contactName}>{c.Name}</span>
                      <span className={styles.contactSub}>{c.Email || c.Title || '—'}</span>
                    </span>
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost btn-icon"
                    title="Unlink contact"
                    aria-label={`Unlink ${c.Name}`}
                    onClick={() => handleUnlinkContact(c)}
                    disabled={Boolean(linkingContactId)}
                  >{linkingContactId === contactKey(c) ? '…' : <ActionIcon name="unlink" />}</button>
                </div>
              ))
            : <p className="text-sm text-muted" style={{ marginBottom: 8 }}>No contacts linked.</p>
          }

          <RelatedContactsPanel
            title="Related contacts for this opportunity"
            hint="Same agency and a matching office"
            matches={relatedContactGroups.opportunityOffice}
            linkingContactId={linkingContactId}
            getKey={contactKey}
            onOpen={openContactPanel}
            onLink={handleLinkContact}
          />
          <RelatedContactsPanel
            title="Similar contacts"
            hint="Same agency and a similar office to a contact already linked here"
            matches={relatedContactGroups.linkedContactOffice}
            linkingContactId={linkingContactId}
            getKey={contactKey}
            onOpen={openContactPanel}
            onLink={handleLinkContact}
          />

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
                        onClick={() => !linkingContactId && handleLinkContact(c)}
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
            <div ref={contactEditRef} className="card" style={{ marginTop: 10, padding: 12 }}>
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
                  <label className="form-label">Offices (comma-separated)</label>
                  <input className="form-input" value={newContactForm.Offices}
                    onChange={(e) => setNewContactForm((f) => ({ ...f, Offices: e.target.value }))} />
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
                {savingContact ? 'Adding…' : 'Add and link contact'}
              </button>
            </div>
          )}
        </Section>

        <Section title="Partners and links" id="overview-links">
          {incumbentPartnerMatch && <div className={styles.partnerLinkRow}><IncumbentPartnerCallout match={incumbentPartnerMatch} onOpenPartner={() => navigate(`/partners?partner=${encodeURIComponent(String(incumbentPartnerMatch.partner['UEI Number'] || '').trim())}`)} /></div>}
          {editingLinks ? (() => {
            const draft = linkDraft
            if (!draft) return null
            const updateDraft = (patch) => setLinkDraft((current) => ({ ...current, ...patch }))
            return <div ref={linksEditRef} className={styles.linksEditor}>
              <div className={styles.fixedLinksEditor}>{[['GovWin link', C.govwin], ['Opportunity folder', C.folder], ['Opportunity slide deck', C.slideDeck]].map(([label, key], index) => <div className={styles.fixedLinkEditRow} key={key}>
                <label className="form-label" htmlFor={`fixed-link-${index}`}>{label}</label>
                <input id={`fixed-link-${index}`} className="form-input" value={draft[key]} placeholder="https://…" onChange={(event) => updateDraft({ [key]: event.target.value })} />
                <button type="button" className="btn btn-ghost btn-icon" aria-label={`Delete ${label}`} title={`Delete ${label}`} onClick={() => updateDraft({ [key]: '' })} disabled={!draft[key]} style={{ color: 'var(--red-600)' }}><ActionIcon name="delete" /></button>
              </div>)}</div>
              <div className={styles.otherLinksEditor}>
                <label className="form-label">Other links</label>
                {draft.other.map((entry, index) => <div key={index} className={styles.linkEditRow}>
                  <input className="form-input" aria-label={`Link ${index + 1} name`} placeholder="Link name" value={entry.label} onChange={(event) => { const next = [...draft.other]; next[index] = { ...entry, label: event.target.value }; updateDraft({ other: next }) }} />
                  <input className="form-input" aria-label={`Link ${index + 1} URL`} placeholder="https://…" value={entry.url} onChange={(event) => { const next = [...draft.other]; next[index] = { ...entry, url: event.target.value }; updateDraft({ other: next }) }} />
                  <button type="button" className="btn btn-ghost btn-icon" aria-label={`Delete link ${index + 1}`} title="Delete link" onClick={() => updateDraft({ other: draft.other.filter((_, itemIndex) => itemIndex !== index) })} style={{ color: 'var(--red-600)' }}><ActionIcon name="delete" /></button>
                </div>)}
                <button type="button" className="btn text-sm" onClick={() => updateDraft({ other: [...draft.other, { label: '', url: '' }] })}>+ Add link</button>
              </div>
              <div className={styles.linkEditorActions}><button type="button" className="btn" onClick={() => { setEditingLinks(false); setLinkDraft(null) }} disabled={savingLinks}>Cancel</button><button type="button" className="btn btn-primary" onClick={saveLinks} disabled={savingLinks}>{savingLinks ? 'Saving…' : 'Save links'}</button></div>
            </div>
          })() : (() => {
            const entries = [
              cur[C.govwin] && { label: 'GovWin opportunity', url: cur[C.govwin] },
              cur[C.folder] && { label: 'Opportunity folder', url: cur[C.folder] },
              cur[C.slideDeck] && { label: 'Opportunity slide deck', url: cur[C.slideDeck] },
              ...cleanLinks(cur[C.otherLinks]).map(parseNamedLink),
            ].filter(Boolean)
            return <>
              <div className={styles.linksToolbar}><button type="button" className="btn text-sm" onClick={beginLinkEdit} disabled={editing} title={editing ? 'Save or cancel the opportunity edit first' : 'Edit links'}><ActionIcon name="edit" /> Edit links</button></div>
              {entries.length === 0 ? <p className="text-sm text-muted">No links added.</p> : <details className={styles.linksDisclosure} open>
                <summary>Opportunity links <span>{entries.length}</span></summary>
                <div className={styles.compactLinks}>{entries.map((entry, index) => <div key={`${entry.url}-${index}`} className={styles.compactLinkRow}>
                  <span><strong>{entry.label || inferredLinkLabel(entry.url)}</strong><small>{inferredLinkLabel(entry.url)}</small></span>
                  <a href={safeUrl(entry.url)} target="_blank" rel="noreferrer" className="btn btn-ghost btn-icon" aria-label={`Open ${entry.label || 'link'}`} title="Open link"><ActionIcon name="open" /></a>
                </div>)}</div>
              </details>}
            </>
          })()}
        </Section>

        <OpportunityFilesPanel opportunity={opp} toast={toast} />

        <div className={`${styles.categoryHeading} ${styles.categoryActivity}`}>Activity</div>
        {/* ── Section 7: Notes ── */}
        {relatedOpportunities.length > 0 && (
          <Section title="Related opportunities">
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

        <OpportunityNotesSection
          id="activity-notes"
          loading={notesLoading}
          notes={visibleNotes}
          editingNoteId={editingNoteId}
          savingNoteId={savingNoteId}
          deletingNoteId={deletingNoteId}
          noteDraft={noteDraft}
          setNoteDraft={setNoteDraft}
          startEditNote={startEditNote}
          saveNote={handleSaveNote}
          deleteNote={handleDeleteNote}
          cancelEdit={() => { setEditingNoteId(null); setNoteDraft('') }}
          newNote={newNote}
          setNewNote={setNewNote}
          addNote={handleAddNote}
          addingNote={addingNote}
          uploadProgress={noteUploadProgress}
        />

        {/* ── Section 8: Tasks ── */}
        <OpportunityTasksSection
          id="activity-tasks"
          tasks={tasks}
          hideDoneTasks={hideDoneTasks}
          setHideDoneTasks={setHideDoneTasks}
          updatingTaskId={updatingTaskId}
          updateTaskStatus={handleTaskStatusChange}
          refreshContext={refreshContext}
          addTask={openAddTask}
          editTask={openEditTask}
          deleteTask={setDeleteTaskTarget}
          deletingTaskId={deletingTaskId}
        />

        <div className={`${styles.categoryHeading} ${styles.categoryResearch}`}>Research</div>
        {hasIncumbentHistory && <div id="research-incumbent" className={styles.sectionAnchor}><IncumbentAwardHistoryPanel incumbentUEI={f(C.incumbentUEI)} incumbentName={f(C.incumbent)} /></div>}
        <div id="research-awards" className={styles.sectionAnchor}><AwardLookupPanel
          opp={opp}
          contractNumber={decodedCN}
          updateOpp={updateOpp}
          toast={toast}
          awards={awards}
          columns={C}
          dateOnly={dateOnly}
          cleanLinks={cleanLinks}
          joinLinks={joinLinks}
        /></div>

        <div id="research-contacts" className={styles.sectionAnchor}><PeopleSearch
          variant="opportunity"
          sourceMode="opportunity-notes"
          scopeId={`opportunity:${opp[C.contractNum] || decodedCN}`}
          scopeLabel={`${opp[C.title] || 'Opportunity'} (${opp[C.contractNum] || decodedCN})`}
          context={peopleSearchContext}
          initialValues={{
            organization: opp[C.incumbent] || opp[C.agency] || '',
            program: opp[C.office] || opp[C.title] || '',
            keywords: [opp[C.title], opp[C.naics]].filter(Boolean).join(', '),
          }}
          contactTypes={['Government', 'Private']}
          onAddContact={createContactOnly}
          onAddAndLinkContact={(contactData) => createAndLinkContact(contactData, { quiet: true })}
          onContinue={continuePeopleSearch}
          toast={toast}
        /></div>

        <div className={`${styles.categoryHeading} ${styles.categoryFollowUp}`}>Follow-up</div>
        <div id="followup-email" className={styles.sectionAnchor}><FollowUpEmailComposer
          opportunity={opp}
          linkedContacts={linkedContacts}
          user={user}
          toast={toast}
        /></div>
        {hasFollowOnMatcher && (
          <div id="followup-rfi" className={styles.sectionAnchor}><RfiFollowUpPanel
            opp={opp}
            contacts={contacts}
            linkedContractNumbers={linkedContractNumbers}
            monitor={rfiFollowUpMonitor}
            onAddToPipeline={handleAddFollowOn}
            onSaveDecision={saveFollowUpDecision}
            onSaveOverride={saveFollowUpOverride}
            focusRequested={focusFollowUps}
            panelRef={followUpPanelRef}
            toast={toast}
            columns={C}
          /></div>
        )}
          </main>
        </div>
      </div>

      {/* ── Add task modal ── */}
      {showAddTask && (
        <Modal title={editingTask ? 'Edit task' : 'New task'} onClose={() => { if (!savingTask) { setShowAddTask(false); setEditingTask(null) } }}
          footer={
            <>
              <button className="btn" onClick={() => { setShowAddTask(false); setEditingTask(null) }} disabled={savingTask}>Cancel</button>
              <button className="btn btn-primary" onClick={submitTask} disabled={savingTask} aria-busy={savingTask}>
                {savingTask ? 'Saving…' : editingTask ? 'Save changes' : 'Create task'}
              </button>
            </>
          }
        >
          <form ref={taskEditRef} onSubmit={(e) => { e.preventDefault(); submitTask() }}>
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
                {editingTask && <div className="form-field">
                  <label className="form-label">Status</label>
                  <select className="form-input" value={taskForm.Status}
                    onChange={(e) => setTaskForm({ ...taskForm, Status: e.target.value })}>
                    <option value="To Do">To do</option><option value="In Progress">In progress</option><option>Done</option>
                  </select>
                </div>}
              </div>
            </div>
          </form>
        </Modal>
      )}

      {deleteTaskTarget && (
        <Modal
          title="Delete task"
          onClose={() => !deletingTaskId && setDeleteTaskTarget(null)}
          footer={<>
            <button className="btn" onClick={() => setDeleteTaskTarget(null)} disabled={Boolean(deletingTaskId)}>Cancel</button>
            <button className="btn btn-danger" onClick={handleDeleteTask} disabled={Boolean(deletingTaskId)}>{deletingTaskId ? 'Deleting…' : 'Delete task'}</button>
          </>}
        >
          <p className="text-sm">Delete <strong>{deleteTaskTarget.Title}</strong>? This cannot be undone.</p>
        </Modal>
      )}

      <RfiActivityPhaseModal
        pendingSave={pendingRfiSave}
        activityPhaseColumn={C.actPhase}
        onClose={() => setPendingRfiSave(null)}
        onSave={(pending) => {
          setPendingRfiSave(null)
          prepareOpportunitySave(pending)
        }}
      />
      <OpportunityRenameModal
        pendingSave={pendingRenameSave}
        preview={renamePreview}
        opportunity={opp}
        columns={{ contractNumber: C.contractNum, title: C.title }}
        saving={saving}
        progress={renameProgress}
        onClose={() => {
          setPendingRenameSave(null)
          setRenamePreview(null)
        }}
        onConfirm={confirmRename}
      />

      {/* ── Delete confirmation modal ── */}
      {confirmDelete && (
        <Modal
          title="Archive opportunity"
          onClose={() => !deleting && setConfirmDelete(false)}
          footer={
            <>
              <button className="btn" onClick={() => setConfirmDelete(false)} disabled={deleting}>Cancel</button>
              <button className="btn btn-danger" onClick={handleDeleteOpportunity} disabled={deleting}>
                {deleting ? 'Archiving…' : 'Archive'}
              </button>
            </>
          }
        >
          <p className="text-sm">
            Archive <strong>{opp[C.title]}</strong> ({decodedCN})?
            It will become read-only, while its notes, tasks, drafts, and SharePoint files remain available.
          </p>
        </Modal>
      )}
    </>
  )
}
