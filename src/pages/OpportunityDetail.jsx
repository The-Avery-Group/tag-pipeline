import { useState, useMemo, useCallback, useEffect, useRef } from 'react'
import { useParams, useNavigate, useSearchParams } from 'react-router-dom'
import { usePipeline } from '@/hooks/usePipeline'
import { useNotes } from '@/hooks/useNotes'
import { useTasks } from '@/hooks/useTasks'
import { useContacts } from '@/hooks/useContacts'
import { usePartners } from '@/hooks/usePartners'
import { useAuth } from '@/auth/AuthContext'
import Topbar from '@/components/Layout/Topbar'
import AIPanel from '@/components/AI/AIPanel'
import { useAwardsLookup } from '@/hooks/useAwardsLookup'
import { useEntityEightA } from '@/hooks/useEntityEightA'
import { effectiveRfiFollowUpCriteria, useRfiFollowUpMonitor } from '@/hooks/useRfiFollowUpMonitor'
import AwardRecordCard from '@/components/Awards/AwardRecordCard'
import IncumbentAwardHistoryPanel from '@/components/Opportunity/IncumbentAwardHistory'
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
  saveRFIFollowUpDecision, saveRFIFollowUpOverride,
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
  incumbentUEI:   'Incumbent (Company UEI)',
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

function opportunityReturnPath(value) {
  // Return destinations are only ever created by the Opportunities page.
  // Keep this guard so a manually edited URL cannot navigate outside the app.
  return typeof value === 'string' && /^\/opportunities(?:\?|$)/.test(value)
    ? value
    : '/opportunities'
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

function dateOnly(value) {
  const raw = String(value || '').trim()
  const iso = raw.match(/^\d{4}-\d{2}-\d{2}/)
  if (iso) return iso[0]
  const parsed = new Date(raw)
  if (Number.isNaN(parsed.getTime())) return raw
  return [parsed.getFullYear(), String(parsed.getMonth() + 1).padStart(2, '0'), String(parsed.getDate()).padStart(2, '0')].join('-')
}

function localDate(value) {
  const date = dateOnly(value)
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? new Date(`${date}T00:00:00`) : new Date(NaN)
}

function sbaProfileUrl(entityData, incumbentUEI) {
  const uei = String(entityData?.uei || incumbentUEI || '').trim().toUpperCase()
  const cageCode = String(entityData?.cageCode || '').trim().toUpperCase()
  return /^[A-Z0-9]{12}$/.test(uei) && /^[A-Z0-9]{5}$/.test(cageCode)
    ? `https://search.certifications.sba.gov/profile/${encodeURIComponent(uei)}/${encodeURIComponent(cageCode)}?page=1`
    : 'https://search.certifications.sba.gov/'
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
  const [selectedModification, setSelectedModification] = useState({})

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
      const value = field.column === C.endDate ? dateOnly(field.value) : field.value
      await updateOpp(opp._rowIndex, { [field.column]: value }, opp)
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
            const modifications = r.modifications || []
            const activeModificationIndex = Math.min(selectedModification[piid] ?? 0, Math.max(modifications.length - 1, 0))
            const activeModification = modifications[activeModificationIndex]
            const activeFields = activeModification?.snapshotFields
              ? activeModification.snapshotFields
              : activeModification
                ? { ...Object.fromEntries(Object.entries(r.fields || {}).filter(([, field]) => field.section !== 'Latest modification')), ...activeModification }
                : r.fields
            const viewingLatestModification = activeModificationIndex === 0
            return (
              <div key={piid || Math.random()}>
                {modifications.length > 0 && <>
                  <div className={awardStyles.modificationTabs} role="tablist" aria-label="Recent modifications">
                    {modifications.map((modification, index) => {
                      const number = modification.modificationNumber?.value || (index === modifications.length - 1 ? 'Base award' : 'Modification')
                      const label = index === 0 ? `Latest · ${number}` : number
                      return <button key={`${number}-${modification.dateSigned?.value || index}`} type="button" role="tab" aria-selected={activeModificationIndex === index} className={`${awardStyles.modificationTab} ${activeModificationIndex === index ? awardStyles.modificationTabActive : ''}`} onClick={() => setSelectedModification((previous) => ({ ...previous, [piid]: index }))}>{label}</button>
                    })}
                  </div>
                  <p className="text-xs text-muted" style={{ margin: '0 0 8px' }}>Each tab shows data reported by SAM for that modification.</p>
                </>}
                <AwardRecordCard
                  piid={piid}
                  isIDV={isIDV}
                  modificationCount={r.modificationCount}
                  originalSignedDate={r.originalSignedDate}
                  samLink={r.samLink}
                  cache={cache}
                  onRefresh={() => lookup({ piid: contractNumber, forceRefresh: true })}
                  refreshing={loading}
                  fields={activeFields}
                  contractLifecycleAlert={viewingLatestModification ? r.contractLifecycleAlert : null}
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
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function RfiFollowUpPanel({ opp, contacts, linkedContractNumbers, monitor, onAddToPipeline, onSaveDecision, onSaveOverride, focusRequested, panelRef, toast }) {
  const opportunityId = opp?.[C.contractNum] || ''
  const status = monitor.statusByOpportunity[String(opportunityId).trim().toLowerCase()]
  const override = monitor.overrides.find((row) => String(row['Opportunity ID'] || '').trim().toLowerCase() === String(opportunityId).trim().toLowerCase())
  const effective = effectiveRfiFollowUpCriteria(opp, contacts, monitor.globalRules, override)
  const [open, setOpen] = useState(false)
  const [editingCriteria, setEditingCriteria] = useState(false)
  const [criteria, setCriteria] = useState(null)
  const [adding, setAdding] = useState(null)
  const [savingCriteria, setSavingCriteria] = useState(false)
  const candidates = status?.candidates || []
  const pending = candidates.filter((candidate) => !candidate.decision)
  const reviewed = candidates.filter((candidate) => candidate.decision)

  useEffect(() => {
    if (!focusRequested) return
    setOpen(true)
    const timer = window.setTimeout(() => panelRef?.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 180)
    return () => window.clearTimeout(timer)
  }, [focusRequested, panelRef])

  const beginCriteriaEdit = () => {
    setCriteria({
      'Monitoring Enabled': override?.['Monitoring Enabled'] || 'Enabled',
      'Use Global Criteria': override?.['Use Global Criteria'] || 'Yes',
      'Department Rule': override?.['Department Rule'] || 'Exact', 'Department Override': override?.['Department Override'] || '',
      'Agency Rule': override?.['Agency Rule'] || 'Exact', 'Agency Override': override?.['Agency Override'] || '',
      'POC Rule': override?.['POC Rule'] || 'Exact', 'POC Email Override': override?.['POC Email Override'] || '',
      'Title Overlap %': override?.['Title Overlap %'] || effective.rules.titleOverlapPercent,
      'Notice Types': override?.['Notice Types'] || effective.rules.noticeTypes,
      'Submission Window Days': override?.['Submission Window Days'] || effective.rules.submissionWindowDays,
      'No-Submission Lookback Days': override?.['No-Submission Lookback Days'] || effective.rules.noSubmissionLookbackDays,
      'No-Submission Lookahead Days': override?.['No-Submission Lookahead Days'] || effective.rules.noSubmissionLookaheadDays,
    })
    setEditingCriteria(true)
  }

  const saveCriteria = async () => {
    setSavingCriteria(true)
    try {
      await onSaveOverride(opportunityId, criteria)
      setEditingCriteria(false)
      toast?.success('RFI follow-up criteria saved')
    } catch (error) {
      toast?.error(`Could not save criteria: ${error.message}`)
    } finally { setSavingCriteria(false) }
  }

  const decide = async (candidate, decision) => {
    monitor.applyDecision(opportunityId, candidate, decision)
    try { await onSaveDecision(candidate, decision) } catch (error) {
      await monitor.loadStatus().catch(() => {})
      toast?.error(`Could not save decision: ${error.message}`)
    }
  }

  const add = async (candidate) => {
    const key = candidate.solicitationNumber || candidate.noticeId
    setAdding(key)
    try { await onAddToPipeline(candidate) } finally { setAdding(null) }
  }

  const ruleSummary = `${effective.rules.departmentRule} department, ${effective.rules.agencyRule} agency, ${effective.rules.pocRule} POC, ${effective.rules.titleOverlapPercent}% title overlap`
  const canCheck = Boolean(effective.rules.monitoringEnabled && effective.title && (effective.rules.departmentRule === 'Ignore' || effective.department) && (effective.rules.agencyRule === 'Ignore' || effective.agency) && (effective.rules.pocRule === 'Ignore' || effective.pocEmail))
  return (
    <div ref={panelRef} className="card" style={{ padding: 0, overflow: 'hidden', marginBottom: 12, scrollMarginTop: 16 }}>
      <button onClick={() => setOpen((value) => !value)} style={{ display: 'flex', gap: 10, alignItems: 'center', width: '100%', padding: '12px 16px', border: 'none', background: 'var(--surface)', cursor: 'pointer', textAlign: 'left', fontFamily: 'var(--font)' }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--gray-900)' }}>RFI Follow-up Checker</div>
          <div className="text-xs text-muted" style={{ marginTop: 2 }}>
            {status?.lastCheckedAt ? `${pending.length} pending result${pending.length === 1 ? '' : 's'} · checked ${formatDate(status.lastCheckedAt)}` : 'Run a targeted SAM.gov follow-up check.'}
          </div>
        </div>
        <span className="text-xs text-muted">{open ? '⌃' : '⌄'}</span>
      </button>
      {open && <div style={{ borderTop: '0.5px solid var(--gray-200)', padding: '12px 16px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 }}>
          <span className="text-xs text-muted">{ruleSummary}</span>
          <div style={{ display: 'flex', gap: 6 }}>
            <button className="btn text-xs" onClick={beginCriteriaEdit}>Criteria</button>
            <button className="btn btn-primary text-xs" onClick={() => monitor.checkOne(opportunityId).catch((error) => toast?.error(`Follow-up check failed: ${error.message}`))} disabled={monitor.checking || !canCheck}>
              {monitor.checking ? 'Checking…' : 'Run check'}
            </button>
          </div>
        </div>
        {editingCriteria && criteria && <div style={{ border: '0.5px solid var(--blue-200)', background: 'var(--blue-50)', borderRadius: 'var(--radius-sm)', padding: 10, marginBottom: 12 }}>
          <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', marginBottom: criteria['Use Global Criteria'] === 'Yes' ? 0 : 12 }}>
            <label className="text-xs"><input type="checkbox" checked={criteria['Monitoring Enabled'] === 'Enabled'} onChange={(e) => setCriteria((prev) => ({ ...prev, 'Monitoring Enabled': e.target.checked ? 'Enabled' : 'Disabled' }))} /> Enable checks</label>
            <label className="text-xs"><input type="checkbox" checked={criteria['Use Global Criteria'] === 'Yes'} onChange={(e) => setCriteria((prev) => ({ ...prev, 'Use Global Criteria': e.target.checked ? 'Yes' : 'No' }))} /> Use global criteria</label>
          </div>
          {criteria['Use Global Criteria'] !== 'Yes' && <>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '8px 14px', marginBottom: 12 }}>
              {[['Department match', 'Department Rule', 'Department Override'], ['Agency match', 'Agency Rule', 'Agency Override'], ['POC email match', 'POC Rule', 'POC Email Override']].map(([label, rule, value]) => <div key={rule}><div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 108px', gap: 6, alignItems: 'center' }}><label className="text-xs">{label}</label><select className="form-input" value={criteria[rule]} onChange={(e) => setCriteria((prev) => ({ ...prev, [rule]: e.target.value }))}><option>Exact</option><option>Ignore</option><option>Override</option></select></div>{criteria[rule] === 'Override' && <input className="form-input" style={{ marginTop: 4 }} placeholder={value} aria-label={value} value={criteria[value]} onChange={(e) => setCriteria((prev) => ({ ...prev, [value]: e.target.value }))} />}</div>)}
              <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 108px', gap: 6, alignItems: 'center' }}><label className="text-xs">Notice types</label><select className="form-input" value={criteria['Notice Types']} onChange={(e) => setCriteria((prev) => ({ ...prev, 'Notice Types': e.target.value }))}><option>RFP, RFQ</option><option>RFP</option><option>RFQ</option></select></div>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '8px 14px' }}>
              <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 108px', gap: 6, alignItems: 'center' }}><label className="text-xs">Minimum title overlap (%)</label><input className="form-input" type="number" min={1} max={100} value={criteria['Title Overlap %']} onChange={(e) => setCriteria((prev) => ({ ...prev, 'Title Overlap %': e.target.value }))} /></div>
              {[['Post-submission window (days)', 'Submission Window Days'], ['No-submission lookback (days)', 'No-Submission Lookback Days'], ['No-submission lookahead (days)', 'No-Submission Lookahead Days']].map(([label, key]) => <div key={key} style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 108px', gap: 6, alignItems: 'center' }}><label className="text-xs">{label}</label><input className="form-input" type="number" min={0} max={364} value={criteria[key]} onChange={(e) => setCriteria((prev) => ({ ...prev, [key]: e.target.value }))} /></div>)}
            </div>
          </>}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6, marginTop: 8 }}><button className="btn text-xs" onClick={() => setEditingCriteria(false)}>Cancel</button><button className="btn btn-primary text-xs" onClick={saveCriteria} disabled={savingCriteria}>{savingCriteria ? 'Saving…' : 'Save criteria'}</button></div>
        </div>}
        {!effective.rules.monitoringEnabled && <p className="text-sm text-muted">Follow-up monitoring is disabled for this RFI.</p>}
        {effective.rules.monitoringEnabled && effective.rules.pocRule === 'Exact' && !effective.pocEmail && <p className="text-sm text-muted">Link a contact with an email address, choose an override, or set the POC rule to Ignore before checking.</p>}
        {monitor.error && <p className="text-sm" style={{ color: 'var(--red-600)' }}>Follow-up check failed: {monitor.error}</p>}
        {!monitor.checking && status?.lastCheckedAt && candidates.length === 0 && <p className="text-sm text-muted">No matching follow-on RFPs or RFQs found.</p>}
        {pending.map((candidate) => {
          const key = candidate.solicitationNumber || candidate.noticeId
          const alreadyLinked = linkedContractNumbers.has(key)
          return <div key={candidate.noticeId || key} style={{ borderTop: '0.5px solid var(--gray-100)', padding: '10px 0' }}><div style={{ display: 'flex', gap: 12, justifyContent: 'space-between', alignItems: 'flex-start' }}><div style={{ minWidth: 0 }}><div style={{ fontSize: 13, fontWeight: 600 }}>{candidate.title || 'Untitled opportunity'}</div><div className="text-xs text-muted" style={{ marginTop: 3 }}>{candidate.solicitationNumber || candidate.noticeId} · {candidate.type || 'Follow-on'} · {candidate.keywordOverlapPercent}% title overlap</div>{candidate.responseDate && <div className="text-xs text-muted" style={{ marginTop: 2 }}>Response: {formatDate(candidate.responseDate)}</div>}</div><div style={{ display: 'flex', gap: 5, flexShrink: 0, alignItems: 'center' }}><button className="btn btn-ghost btn-icon" title="Approve result" aria-label="Approve result" onClick={() => decide(candidate, 'Approved')}>✓</button><button className="btn btn-ghost btn-icon" title="Reject and remove result" aria-label="Reject and remove result" onClick={() => decide(candidate, 'Rejected')}>✕</button>{candidate.samLink && <a className="btn text-xs" href={safeUrl(candidate.samLink)} target="_blank" rel="noreferrer">SAM.gov ↗</a>}</div></div></div>
        })}
        {reviewed.length > 0 && <details style={{ marginTop: 8 }}><summary className="text-xs text-muted" style={{ cursor: 'pointer' }}>Reviewed results ({reviewed.length})</summary>{reviewed.map((candidate) => { const key = candidate.solicitationNumber || candidate.noticeId; const approved = candidate.decision === 'Approved'; const alreadyLinked = linkedContractNumbers.has(key); return <div key={candidate.noticeId || key} style={{ borderTop: '0.5px solid var(--gray-100)', padding: '9px 0', display: 'flex', justifyContent: 'space-between', gap: 8 }}><div><strong className="text-sm">{candidate.title || 'Untitled opportunity'}</strong><div className="text-xs text-muted">{candidate.decision}</div></div><div style={{ display: 'flex', gap: 5, alignItems: 'center' }}>{approved && <button className="btn btn-primary text-xs" onClick={() => add(candidate)} disabled={Boolean(adding) || alreadyLinked}>{alreadyLinked ? 'Linked' : adding === key ? 'Adding…' : 'Add & link'}</button>}<button className="btn btn-ghost btn-icon" title="Reject and remove result" aria-label="Reject and remove result" onClick={() => decide(candidate, 'Rejected')}>✕</button></div></div> })}</details>}
      </div>}
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
  const returnTo = opportunityReturnPath(searchParams.get('returnTo'))
  const navigate  = useNavigate()
  const { user }  = useAuth()

  const { pipeline, loading: pipelineLoading, add: addPipelineOpp, update: updateOpp, remove: removeOpp } = usePipeline()
  const { notes, loading: notesLoading, add: addNote, update: updateNote, remove: removeNote } = useNotes(decodedCN)
  const { tasks, add: addTask, update: updateTask, refreshContext } = useTasks(decodedCN)
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
  const addingNoteRef = useRef(false)
  const [deletingNoteId,  setDeletingNoteId]  = useState(null)
  const [editingNoteId,   setEditingNoteId]   = useState(null)
  const [noteDraft,       setNoteDraft]       = useState('')
  const [savingNoteId,    setSavingNoteId]    = useState(null)
  const [showAddTask,     setShowAddTask]     = useState(false)
  const [savingTask,      setSavingTask]      = useState(false)
  const creatingTaskRef = useRef(false)
  const [updatingTaskId,  setUpdatingTaskId]  = useState(null)
  const [taskForm,        setTaskForm]        = useState({
    Title: '', Description: '', AssignedTo: '', DueDate: '', Priority: 'Medium',
  })
  const [contactSearch,   setContactSearch]   = useState('')
  const [linkingContactId, setLinkingContactId] = useState(null)
  const linkingContactIdsRef = useRef(new Set())
  const [showNewContact,  setShowNewContact]  = useState(false)
  const [savingContact,   setSavingContact]   = useState(false)
  const [newContactForm,  setNewContactForm]  = useState({
    Name: '', Title: '', Agency: '', Organization: '', Offices: '', Email: '', Phone: '', Type: 'Government',
  })
  const [hideDoneTasks, setHideDoneTasks] = useState(true)
  const [pendingRfiSave, setPendingRfiSave] = useState(null)
  const [pendingRenameSave, setPendingRenameSave] = useState(null)
  const [renamePreview, setRenamePreview] = useState(null)
  const [renameProgress, setRenameProgress] = useState('')
  const [addingEightANote, setAddingEightANote] = useState(false)
  const [eightANoteAdded, setEightANoteAdded] = useState(false)
  

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

  const incumbentEightA = useEntityEightA(opp?.[C.incumbentUEI])
  const rfiFollowUpMonitor = useRfiFollowUpMonitor(opp ? [opp] : [], contacts)
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
        <button className="btn btn-ghost" onClick={() => navigate(returnTo)}>← Back</button>
        <p className="text-muted mt-3">Opportunity not found.</p>
      </div>
    )
  }

  // ── Helpers that depend on opp (safe below early returns) ─────────────
  const cur = form || opp

  const f = (key) => cur[key]
  const set = (key) => (val) => setForm((prev) => ({ ...prev, [key]: val }))
  const isRFI = opp[C.phase] === 'Identified' && opp[C.outlook] === 'New'
  const hasSubmissionDate = !Number.isNaN(localDate(opp[C.submDate]).getTime())
  const linkedContractNumbers = new Set(relatedOpportunities.map((related) => related.contractNumber))
  const followUpStatus = rfiFollowUpMonitor.statusByOpportunity[normalizeOpportunityKey(opp[C.contractNum])]

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
      await invalidateCache(['PipelineTable', 'TasksTable', 'NotesTable', 'ContactsTable'])
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
    if (addingNoteRef.current || !newNote.trim()) return
    addingNoteRef.current = true
    setAddingNote(true)
    try {
      await addNote(user.firstName, newNote.trim())
      setNewNote('')
      toast?.success('Note added')
    } catch (err) {
      toast?.error(`Failed to add note: ${err.message}`)
    } finally {
      addingNoteRef.current = false
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
      await retryThrice(() => updateOpp(opp._rowIndex, { [C.poc]: nextPOC }, opp))
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
      setNewContactForm({ Name: '', Title: '', Agency: '', Organization: '', Offices: '', Email: '', Phone: '', Type: 'Government' })
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
      await invalidateCache(['PipelineTable', 'ContactsTable'])
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
    await invalidateCache(['PipelineTable', 'ContactsTable'])
    toast?.success('Follow-on added and linked to this RFI')
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
      creatingTaskRef.current = false
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
        rightContent={<div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          {followUpStatus?.badgeVisible && <button className="badge" style={{ background: followUpStatus.badgeState === 'seen' ? 'var(--gray-100)' : 'var(--blue-50)', border: `0.5px solid ${followUpStatus.badgeState === 'seen' ? 'var(--gray-300)' : 'var(--blue-200)'}`, color: followUpStatus.badgeState === 'seen' ? 'var(--gray-600)' : 'var(--blue-800)', cursor: 'pointer' }} onClick={() => { rfiFollowUpMonitor.markSeen(opp[C.contractNum]).catch(() => {}); const next = new URLSearchParams(searchParams); next.set('focus', 'follow-ups'); navigate({ search: `?${next.toString()}` }, { replace: true }) }} title={`${followUpStatus.pendingCount} possible follow-up${followUpStatus.pendingCount === 1 ? '' : 's'}`}>
            {followUpStatus.badgeState === 'seen' ? 'Follow-ups seen' : `${followUpStatus.pendingCount} possible follow-up${followUpStatus.pendingCount === 1 ? '' : 's'}`}
          </button>}
          {contractLifecycleAlert && <span className={`badge ${contractLifecycleBadgeClass}`} title={contractLifecycleTooltip}>{contractLifecycleAlert.reason}</span>}
          {incumbentPartnerMatch && <span className={styles.partnerBadge} title={`Exact UEI match to TAG partner ${incumbentPartnerMatch.partner['Partner Name']}`}>Incumbent is a TAG partner</span>}
        </div>}
      />

      <div className="page-body">
        <button className="btn btn-ghost text-sm" style={{ marginBottom: 14 }}
          onClick={() => navigate(returnTo)}>
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
            <Field label="Incumbent UEI"           value={f(C.incumbentUEI)}   editing={editing} onChange={set(C.incumbentUEI)} raw />
            <EightAExitCallout
              entityData={incumbentEightA.data}
              incumbentUEI={f(C.incumbentUEI)}
              loading={incumbentEightA.loading}
              error={incumbentEightA.error}
              contractEndDate={f(C.endDate)}
              onAddNote={handleAddEightANote}
              addingNote={addingEightANote}
              noteAdded={eightANoteAdded}
            />
            <IncumbentPartnerCallout
              match={incumbentPartnerMatch}
              onOpenPartner={() => navigate(`/partners?partner=${encodeURIComponent(String(incumbentPartnerMatch.partner['UEI Number'] || '').trim())}`)}
            />
            <IncumbentAwardHistoryPanel incumbentUEI={f(C.incumbentUEI)} />
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
                {(isRFI || (editing && hasSubmissionDate)) && (
                  <Field label="RFI Submission Date" value={f(C.submDate)} editing={editing} onChange={set(C.submDate)} type="date" />
                )}
                <Field label="Contract End Date"      value={f(C.endDate)}    editing={editing} onChange={set(C.endDate)}    type="date" />
                <Field label="Anticipated Award Date" value={f(C.awardDate)}  editing={editing} onChange={set(C.awardDate)}  type="date" />
                <Field label="Fiscal Year"            value={f(C.fiscalYear)} editing={editing} onChange={set(C.fiscalYear)} raw />
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
                    onClick={() => handleUnlinkContact(c)}
                  >✕</button>
                </div>
              ))
            : <p className="text-sm text-muted" style={{ marginBottom: 8 }}>No contacts linked.</p>
          }

          {relatedContactGroups.opportunityOffice.length > 0 && (
            <div className={styles.relatedContacts}>
              <div className={styles.relatedContactsTitle}>Related contacts for this opportunity</div>
              <div className={styles.relatedContactsHint}>Same agency and a matching office</div>
              {relatedContactGroups.opportunityOffice.map(({ contact: c, reason }) => {
                const key = contactKey(c)
                const isLinking = linkingContactId === key
                return (
                  <div key={key} className={styles.contactCard}>
                    <button type="button" className={styles.contactOpen} onClick={() => openContactPanel(c)} title={`Open ${c.Name || 'contact'}`}>
                      <span className={styles.contactAv}>{c.Name?.split(' ').map((n) => n[0]).slice(0, 2).join('')}</span>
                      <span className={styles.contactInfo}>
                        <span className={styles.contactName}>{c.Name}</span>
                        <span className={styles.contactSub}>{[c.Title, c.Email].filter(Boolean).join(' · ') || 'Related contact'}</span>
                        <span className={styles.relatedContactReason}>{reason}</span>
                      </span>
                    </button>
                    <button
                      type="button"
                      className="btn btn-primary text-sm"
                      disabled={Boolean(linkingContactId)}
                      onClick={() => handleLinkContact(c)}
                    >{isLinking ? 'Linking…' : 'Link'}</button>
                  </div>
                )
              })}
            </div>
          )}

          {relatedContactGroups.linkedContactOffice.length > 0 && (
            <div className={styles.relatedContacts}>
              <div className={styles.relatedContactsTitle}>Related to linked contacts</div>
              <div className={styles.relatedContactsHint}>Same agency and a similar office to a contact already linked here</div>
              {relatedContactGroups.linkedContactOffice.map(({ contact: c, reason }) => {
                const key = contactKey(c)
                const isLinking = linkingContactId === key
                return (
                  <div key={key} className={styles.contactCard}>
                    <button type="button" className={styles.contactOpen} onClick={() => openContactPanel(c)} title={`Open ${c.Name || 'contact'}`}>
                      <span className={styles.contactAv}>{c.Name?.split(' ').map((n) => n[0]).slice(0, 2).join('')}</span>
                      <span className={styles.contactInfo}>
                        <span className={styles.contactName}>{c.Name}</span>
                        <span className={styles.contactSub}>{[c.Title, c.Email].filter(Boolean).join(' · ') || 'Related contact'}</span>
                        <span className={styles.relatedContactReason}>{reason}</span>
                      </span>
                    </button>
                    <button
                      type="button"
                      className="btn btn-primary text-sm"
                      disabled={Boolean(linkingContactId)}
                      onClick={() => handleLinkContact(c)}
                    >{isLinking ? 'Linking…' : 'Link'}</button>
                  </div>
                )
              })}
            </div>
          )}

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
                      {!n._temp && editingNoteId !== n._rowIndex && (
                        <button
                          type="button"
                          className="btn btn-ghost btn-icon"
                          style={{ width: 18, height: 18, padding: 0, fontSize: 11, color: 'var(--blue-600)', marginLeft: 'auto' }}
                          onClick={() => startEditNote(n)}
                          disabled={savingNoteId !== null || deletingNoteId === n._rowIndex}
                          aria-label="Edit note"
                          title="Edit note"
                        >✎</button>
                      )}
                      {!n._temp && (
                        <button
                          type="button"
                          className="btn btn-ghost btn-icon"
                          style={{ width: 18, height: 18, padding: 0, fontSize: 11, color: 'var(--red-600)' }}
                          onClick={() => handleDeleteNote(n)}
                          disabled={deletingNoteId === n._rowIndex || savingNoteId !== null}
                          aria-label="Delete note"
                          title="Delete note"
                        >
                          {deletingNoteId === n._rowIndex ? '…' : '✕'}
                        </button>
                      )}
                    </div>
                    {editingNoteId === n._rowIndex
                      ? <div className={styles.noteEditor}>
                          <textarea className="form-input" rows={3} value={noteDraft} onChange={(event) => setNoteDraft(event.target.value)} disabled={savingNoteId === n._rowIndex} />
                          <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                            <button type="button" className="btn btn-primary text-sm" onClick={() => handleSaveNote(n)} disabled={savingNoteId === n._rowIndex || !noteDraft.trim()}>{savingNoteId === n._rowIndex ? 'Saving…' : 'Save note'}</button>
                            <button type="button" className="btn text-sm" onClick={() => { setEditingNoteId(null); setNoteDraft('') }} disabled={savingNoteId === n._rowIndex}>Cancel</button>
                          </div>
                        </div>
                      : <div className={styles.noteText}>{linkifyText(n.NoteText)}</div>}
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

        {isRFI && (
          <RfiFollowUpPanel
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
          />
        )}
      </div>

      {/* ── Add task modal ── */}
      {showAddTask && (
        <Modal title="Add task" onClose={() => !savingTask && setShowAddTask(false)}
          footer={
            <>
              <button className="btn" onClick={() => setShowAddTask(false)} disabled={savingTask}>Cancel</button>
              <button className="btn btn-primary" onClick={submitTask} disabled={savingTask} aria-busy={savingTask}>
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
