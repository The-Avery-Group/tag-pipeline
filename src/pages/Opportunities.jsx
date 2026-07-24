import { useState, useMemo, useEffect, useLayoutEffect, useRef, useCallback } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { usePipeline } from '@/hooks/usePipeline'
import { useValidationLists, pickList } from '@/hooks/useValidationLists'
import { useSAMOpportunities, checkSAMKeyExpired, getSAMRunStatus } from '@/hooks/useSAMOpportunities'
import { useSAMChangeMonitor } from '@/hooks/useSAMChangeMonitor'
import { useRfiFollowUpMonitor } from '@/hooks/useRfiFollowUpMonitor'
import { useContacts } from '@/hooks/useContacts'
import { useNotes } from '@/hooks/useNotes'
import { useAsyncAction } from '@/hooks/useAsyncAction'
import { useScrollRestoration } from '@/hooks/useScrollRestoration'
import Topbar from '@/components/Layout/Topbar'
import Modal from '@/components/Common/Modal'
import { formatDate, formatDateTime, getEndDateBand, EXPIRING_BANDS } from '@/utils/kpiHelpers'
import { recordMatches } from '@/utils/searchHelpers'
import { OPPORTUNITY_PHASES, OPPORTUNITY_OUTLOOK, SET_ASIDE_VALUES, PRIORITY_VALUES, ASSIGNEE_VALUES } from '@/services/graphService'
import styles from './Opportunities.module.css'

// ── Column name constants ─────────────────────────────────────────────────
const C = {
  phase:        'TAG Opportunity Phase',
  activityPhase:'TAG Pipeline Activity Phase',
  contractNum:  'Contract Number / Notice ID',
  title:        'Project Title / Description*',
  agency:       'Agency*',
  department:   'Department*',
  value:        'Total Contract Value ($)*',
  assignedTo:   'Assigned To*',
  lastMod:      'Last Modified*',
  submDate:     'Submission Date (Response Date)*',
  solNum:       'Solicitation Number',
  naics:        'NAICS Code*',
  outlook:      'Opportunity Outlook',
  priority:     'Priority',
  setAside:     'Set- Aside*',
  poc:          'Contracting Officer / Specialist (POC)*',
  endDate:      'Contract End Date*',
  bidNoBid:     'Bid / No Bid?',
  partner:      'Partner',
  primeOrSub:   'Prime or Sub?',
  notes:        'Notes*',
  awardDate:    'Anticipated year for Award (MM/DD/YYYY)*',
  folder:       'Link to Folder',
  govwin:       'GovWin Link*',
  classification: 'Contract Classification*',
  vehicle:      'Contract Vehicle',
}

// ── Tab definitions ───────────────────────────────────────────────────────
const TABS = ['All', 'RFIs', 'Expiring', 'Tracked', 'New']

// ── Phase badge map ───────────────────────────────────────────────────────
const PHASE_BADGE = {
  'Identified':       'badge-tracking',
  'Research':         'badge-qualify',
  'Qualified':        'badge-qualify',
  'Proposal':         'badge-proposal',
  'Pending Award':    'badge-negotiation',
  'Contract Awarded': 'badge-award',
  'Cancelled':        'badge-closed-lost',
}

// ── Priority badge map ────────────────────────────────────────────────────
const PRIORITY_BADGE = {
  'Hot':  'badge-closed-lost',   // red — reuse existing badge tokens rather than adding new CSS
  'Warm': 'badge-proposal',      // amber/orange
  'Cold': 'badge-tracking',      // neutral
}

// ── Per-tab row filter (base filter before search/advanced filters) ────────
function getTabRows(pipeline, tab) {
  switch (tab) {
    case 'All':
      return pipeline
    case 'RFIs':
      return pipeline.filter(
        (o) => o[C.phase] === 'Identified' && o[C.outlook] === 'New'
      )
    case 'Expiring':
      return pipeline.filter((o) => o[C.outlook] === 'Expiring')
    case 'Tracked':
      return pipeline.filter((o) => o[C.outlook] === 'Tracking')
    default:
      return []
  }
}

// ── Per-tab default sort ──────────────────────────────────────────────────
const TAB_DEFAULT_SORT = {
  All:      { key: C.lastMod,  dir: 'desc' },
  RFIs:     { key: C.submDate, dir: 'desc' },
  Expiring: { key: C.endDate,  dir: 'asc'  },
  Tracked:  { key: C.lastMod,  dir: 'desc' },
  New:      { key: 'Response Date', dir: 'asc'  },
}

// ── Value formatter ───────────────────────────────────────────────────────
// Human-readable labels for filter chips where the raw stored value isn't
// self-explanatory (band keys, YYYY-MM month keys).
function filterChipLabel(key, val) {
  if (key === 'endBand') {
    const band = EXPIRING_BANDS.find((b) => b.key === val)
    return band ? band.label : val
  }
  if (key === 'rfiMonth') {
    const [y, m] = val.split('-').map(Number)
    const d = new Date(y, m - 1, 1)
    return d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
  }
  if (key === 'endYear') return val
  return val
}

function fmtValue(v) {
  const n = parseFloat(String(v ?? '').replace(/[^0-9.]/g, ''))
  if (!n) return '—'
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `$${(n / 1_000).toFixed(0)}K`
  return `$${n.toFixed(0)}`
}

function normalizeOpportunityKey(value) {
  return String(value || '').trim().toLowerCase()
}

// ── Main component ────────────────────────────────────────────────────────
export default function Opportunities({ toast }) {
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const { pipeline, loading, add, remove } = usePipeline()
  const { contacts } = useContacts()
  const { notes } = useNotes()
  const { lists } = useValidationLists()
  useScrollRestoration()   // restores page scroll position on back-navigation from a detail page

  const outlookOptions        = pickList(lists, 'Opportunity Outlook', OPPORTUNITY_OUTLOOK)
  const priorityOptions       = pickList(lists, 'Priority', PRIORITY_VALUES)
  const setAsideOptions       = pickList(lists, 'Set-Aside', SET_ASIDE_VALUES)
  const bidNoBidOptions       = pickList(lists, 'Bid / No Bid?', ['Bid', 'No Bid', 'TBD'])
  const phaseOptions          = pickList(lists, 'TAG Opportunity Phase', OPPORTUNITY_PHASES)
  const primeOrSubOptions     = pickList(lists, 'Prime or Sub?', ['Prime', 'Sub'])
  const assigneeOptions       = pickList(lists, 'Assignee', ASSIGNEE_VALUES)

  // SAM rows and pipeline rows share the solicitation/notice number. Indexing
  // both pipeline fields keeps a New-tab result linked even when one source
  // provides the number as a notice ID and the other as a solicitation number.
  const pipelineByOpportunityKey = useMemo(() => {
    const index = new Map()
    pipeline.forEach((opportunity) => {
      [opportunity[C.contractNum], opportunity[C.solNum]].forEach((value) => {
        const key = normalizeOpportunityKey(value)
        if (key) index.set(key, opportunity)
      })
    })
    return index
  }, [pipeline])

  // ── URL-param-driven list state ─────────────────────────────────────────
  // Active tab, search text, and every filter live in the URL rather than
  // component state. This does double duty: filters persist across
  // navigation (leave the page, come back, still filtered), AND any other
  // page can link directly into a pre-filtered, visibly-active view (e.g. a
  // Dashboard chart segment linking to /opportunities?tab=All&phase=Proposal
  // shows real, dismissible filter chips exactly as if applied manually).
  const requestedTab = searchParams.get('tab')
  const activeTab = TABS.includes(requestedTab) ? requestedTab : 'All'
  const search    = searchParams.get('search') || ''
  const rfiFollowUpIds = useMemo(() => {
    try {
      const values = JSON.parse(searchParams.get('rfiFollowUps') || '[]')
      return new Set(Array.isArray(values) ? values.map((value) => String(value).trim()).filter(Boolean) : [])
    } catch {
      return new Set()
    }
  }, [searchParams])

  const filters = useMemo(() => ({
    outlook:        searchParams.get('outlook') || '',
    priority:       searchParams.get('priority') || '',
    assignedTo:     searchParams.get('assignedTo') || '',
    setAside:       searchParams.get('setAside') || '',
    bidNoBid:       searchParams.get('bidNoBid') || '',
    phase:          searchParams.get('phase') || '',
    primeOrSub:     searchParams.get('primeOrSub') || '',
    endBand:        searchParams.get('endBand') || '',
    endYear:        searchParams.get('endYear') || '',
    rfiMonth:       searchParams.get('rfiMonth') || '',
    classification: searchParams.get('classification') || '',
    vehicle:        searchParams.get('vehicle') || '',
    agency:         new Set((searchParams.get('agency') || '').split(',').filter(Boolean)),
  }), [searchParams])

  // Merges a patch into the URL params (deleting keys whose value is empty,
  // so the URL stays clean and activeFilterCount stays accurate). Uses
  // `replace` navigation so tweaking filters doesn't spam browser history —
  // the back button should leave the page, not undo filter clicks one at a time.
  const updateParams = (patch) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev)
      Object.entries(patch).forEach(([key, val]) => {
        if (val == null || val === '' || (val instanceof Set && val.size === 0)) {
          next.delete(key)
        } else if (val instanceof Set) {
          next.set(key, [...val].join(','))
        } else {
          next.set(key, val)
        }
      })
      return next
    }, { replace: true })
  }

  const setSearch    = (val) => updateParams({ search: val })
  // Supports both setFilters({ outlook: 'X' }) and the functional form
  // setFilters(prev => ({ ...prev, outlook: 'X' })) used by several existing
  // call sites (notably the agency multi-select toggle) — resolved against
  // the current `filters` before being merged into the URL.
  const setFilters = (patchOrFn) => {
    const patch = typeof patchOrFn === 'function' ? patchOrFn(filters) : patchOrFn
    updateParams(patch)
  }

  // ── Tab state — each tab carries its own sort so switching tabs restores
  //    the right default rather than sharing a single sort state
  const [tabSort, setTabSort] = useState(TAB_DEFAULT_SORT)

  const sortKey = tabSort[activeTab]?.key  ?? C.lastMod
  const sortDir = tabSort[activeTab]?.dir  ?? 'desc'

  const handleSort = (key) => {
    setTabSort((prev) => {
      const cur = prev[activeTab]
      const newDir = cur.key === key ? (cur.dir === 'asc' ? 'desc' : 'asc') : 'asc'
      return { ...prev, [activeTab]: { key, dir: newDir } }
    })
  }

  // ── Advanced filter panel UI state (not persisted — just whether it's open) ──
  const [showFilter, setShowFilter] = useState(false)
  const activeFilterCount = Object.entries(filters)
    .filter(([k, v]) => k === 'agency' ? v.size > 0 : Boolean(v)).length + (rfiFollowUpIds.size ? 1 : 0)
  const [agencyFilterOpen, setAgencyFilterOpen] = useState(false)
  const agencyFilterRef = useRef(null)

  // Close agency filter dropdown on outside click
  useEffect(() => {
    if (!agencyFilterOpen) return
    const handler = (e) => {
      if (agencyFilterRef.current && !agencyFilterRef.current.contains(e.target)) {
        setAgencyFilterOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [agencyFilterOpen])

  // ── Modals ────────────────────────────────────────────────────────────
  const [showAdd, setShowAdd] = useState(searchParams.get('new') === '1')
  // ── Shared in-progress feedback (consistent loading state across actions) ──
  const deleteAction      = useAsyncAction()   // pipeline opportunity delete (confirm modal)
  const bulkDismissAction = useAsyncAction()   // New-tab bulk dismiss
  const [confirmDelete, setConfirmDelete] = useState(null)
  const [saving, setSaving] = useState(false)
  const creatingOpportunityRef = useRef(false)
  const addingPipelineRowsRef = useRef(new Set())
  const [confirmRfiActivity, setConfirmRfiActivity] = useState(false)
  const [form, setForm] = useState({
    [C.contractNum]: '',
    [C.title]:       '',
    [C.agency]:      '',
    [C.department]:  '',
    [C.phase]:       'Identified',
    [C.outlook]:     'New',
    [C.value]:       '',
    [C.assignedTo]:  '',
    [C.solNum]:      '',
    [C.naics]:       '',
    [C.submDate]:    '',
    [C.activityPhase]: '',
    [C.priority]:    'Warm',
    [C.setAside]:    '-',
    [C.primeOrSub]:  'Prime',
  })

  // ── Tab counts (raw, before search/filters) ───────────────────────────
  const tabCounts = useMemo(() => ({
    All:      pipeline.length,
    RFIs:     getTabRows(pipeline, 'RFIs').length,
    Expiring: getTabRows(pipeline, 'Expiring').length,
    Tracked:  getTabRows(pipeline, 'Tracked').length,
    New:      0,
  }), [pipeline])

  // ── Distinct agencies present in the active tab (for the agency filter) ──
  const tabAgencies = useMemo(() => {
    const ags = new Set()
    getTabRows(pipeline, activeTab).forEach((o) => {
      const a = String(o[C.agency] || '').trim()
      if (a) ags.add(a)
    })
    return [...ags].sort()
  }, [pipeline, activeTab])

  // ── Distinct Classification / Contract Vehicle values present in the
  //    active tab (no fixed validation list for these — derived from data,
  //    same approach as tabAgencies) ────────────────────────────────────
  const classificationOptions = useMemo(() => {
    const vals = new Set()
    getTabRows(pipeline, activeTab).forEach((o) => {
      const v = String(o[C.classification] || '').trim()
      if (v) vals.add(v)
    })
    return [...vals].sort()
  }, [pipeline, activeTab])

  const vehicleOptions = useMemo(() => {
    const vals = new Set()
    getTabRows(pipeline, activeTab).forEach((o) => {
      const v = String(o[C.vehicle] || '').trim()
      if (v) vals.add(v)
    })
    return [...vals].sort()
  }, [pipeline, activeTab])

  const noteContractsMatchingSearch = useMemo(() => {
    if (!search.trim()) return new Set()
    return new Set(notes
      .filter((note) => recordMatches(note, search))
      .map((note) => String(note.ContractNumber || '').trim())
      .filter(Boolean))
  }, [notes, search])

  // ── Filtered + sorted rows for the active tab ─────────────────────────
  const filtered = useMemo(() => {
    if (activeTab === 'New') return []

    let rows = getTabRows(pipeline, activeTab)

    if (rfiFollowUpIds.size > 0) {
      rows = rows.filter((o) => rfiFollowUpIds.has(String(o[C.contractNum] || '').trim()))
    }

    if (search.trim()) {
      rows = rows.filter((o) =>
        recordMatches(o, search) || noteContractsMatchingSearch.has(String(o[C.contractNum] || '').trim())
      )
    }

    if (filters.outlook)    rows = rows.filter((o) => o[C.outlook]   === filters.outlook)
    if (filters.priority)   rows = rows.filter((o) => o[C.priority]  === filters.priority)
    if (filters.setAside)   rows = rows.filter((o) => o[C.setAside]  === filters.setAside)
    if (filters.bidNoBid)   rows = rows.filter((o) => o[C.bidNoBid]  === filters.bidNoBid)
    if (filters.phase)          rows = rows.filter((o) => o[C.phase]          === filters.phase)
    if (filters.primeOrSub)     rows = rows.filter((o) => o[C.primeOrSub]     === filters.primeOrSub)
    if (filters.classification) rows = rows.filter((o) => o[C.classification] === filters.classification)
    if (filters.vehicle)        rows = rows.filter((o) => o[C.vehicle]        === filters.vehicle)
    if (filters.endBand)        rows = rows.filter((o) => getEndDateBand(o[C.endDate]) === filters.endBand)
    if (filters.endYear)         rows = rows.filter((o) => {
      const d = new Date((o[C.endDate] || '') + 'T00:00:00')
      return !isNaN(d) && String(d.getFullYear()) === filters.endYear
    })
    // Dates are stored as 'YYYY-MM-DD' ISO strings, so a prefix match against
    // a 'YYYY-MM' filter value is exact and doesn't need Date parsing.
    if (filters.rfiMonth)       rows = rows.filter((o) => String(o[C.submDate] || '').startsWith(filters.rfiMonth))
    if (filters.assignedTo) rows = rows.filter((o) => o[C.assignedTo] === filters.assignedTo)
    if (filters.agency.size > 0) rows = rows.filter((o) =>
      filters.agency.has(String(o[C.agency] || '').trim())
    )

    return [...rows].sort((a, b) => {
      const va = a[sortKey] ?? ''
      const vb = b[sortKey] ?? ''
      const cmp = va < vb ? -1 : va > vb ? 1 : 0
      return sortDir === 'asc' ? cmp : -cmp
    })
  }, [pipeline, activeTab, search, filters, rfiFollowUpIds, noteContractsMatchingSearch, sortKey, sortDir])

  // ── Tab switch — filters are scoped to the tab that applied them. Search
  // remains because it is a separate, deliberate cross-tab lookup.
  const handleTabChange = (tab) => {
    updateParams({
      tab,
      outlook: '', priority: '', assignedTo: '', agency: new Set(), setAside: '', bidNoBid: '',
      phase: '', primeOrSub: '', endBand: '', endYear: '', rfiMonth: '', classification: '', vehicle: '', rfiFollowUps: '',
    })
    setShowFilter(false)
    setAgencyFilterOpen(false)
  }

  // The visible contract/notice number may contain whitespace or characters
  // that Excel/URLs normalize differently. Carrying the stable table row
  // index makes detail navigation reliable while retaining the readable URL.
  const openOpportunity = (opp, { focusFollowUps = false } = {}) => {
    const cn = opp[C.contractNum] || ''
    // Keep the complete list URL so the detail page's own back button can
    // restore the exact tab, search, and filters the user came from.
    const detailParams = new URLSearchParams({ row: String(opp._rowIndex) })
    if (focusFollowUps) detailParams.set('focus', 'follow-ups')
    const currentListQuery = searchParams.toString()
    detailParams.set('returnTo', `/opportunities${currentListQuery ? `?${currentListQuery}` : ''}`)
    navigate(`/opportunities/${encodeURIComponent(cn)}?${detailParams.toString()}`)
  }

  // ── CRUD handlers ─────────────────────────────────────────────────────
  const submitOpp = async ({ setSubmittedRfi = false } = {}) => {
    if (creatingOpportunityRef.current) return
    creatingOpportunityRef.current = true
    const payload = setSubmittedRfi ? { ...form, [C.activityPhase]: 'Submitted RFI' } : form
    setSaving(true)
    try {
      await add(payload)
      toast?.success('Opportunity added')
      setShowAdd(false)
      setForm({
        [C.contractNum]: '', [C.title]: '', [C.agency]: '', [C.department]: '',
        [C.phase]: 'Identified', [C.outlook]: 'New', [C.value]: '',
        [C.assignedTo]: '', [C.solNum]: '', [C.naics]: '', [C.submDate]: '', [C.activityPhase]: '',
        [C.priority]: 'Warm', [C.setAside]: '-', [C.primeOrSub]: 'Prime',
      })
    } catch (err) {
      toast?.error(`Failed to add: ${err.message}`)
    } finally {
      creatingOpportunityRef.current = false
      setSaving(false)
    }
  }

  const requestAdd = () => {
    const needsActivityPrompt =
      form[C.phase] === 'Identified' &&
      form[C.outlook] === 'New' &&
      form[C.submDate] &&
      !form[C.activityPhase]
    if (needsActivityPrompt) {
      setConfirmRfiActivity(true)
      return
    }
    submitOpp()
  }

  const handleAdd = (e) => { e.preventDefault(); requestAdd() }

  const handleDelete = async () => {
    if (!confirmDelete) return
    try {
      await deleteAction.run(() => remove(confirmDelete._rowIndex), {
        onError: (err) => toast?.error(`Failed to delete: ${err.message}`),
      })
      toast?.success('Opportunity deleted')
      setConfirmDelete(null)
    } catch {
      // Error already toasted via onError — leave the modal open so the user can retry
    }
  }

  // ── SAM opportunities (New tab) ───────────────────────────────────────
  const {
    opportunities: samOpps,
    loading: samLoading,
    addToPipeline,
    dismiss,
    undismiss,
    failedStatuses,
    retryStatus,
    triggerPull,
    pullProgress,
    pullOrigin,
  } = useSAMOpportunities()

  const { changesByRow: samChangesByRow, checking: checkingSAMChanges, progress: samCheckProgress, checkError: samCheckError, checkChanges: checkSAMChanges, markReviewed: markSAMChangeReviewed } = useSAMChangeMonitor(samOpps)
  const { statusByOpportunity: rfiFollowUpStatus, markSeen: markFollowUpsSeen } = useRfiFollowUpMonitor(pipeline, contacts, { replace: true })

  const [showDismissed, setShowDismissed] = useState(false)
  const [samKeyExpired, setSamKeyExpired] = useState(false)
  const [actioningRow,  setActioningRow]  = useState(null)
  const [selectedRows,  setSelectedRows]  = useState(new Set())   // bulk select: Set of _rowIndex
  const [deptOpen,      setDeptOpen]      = useState(false)       // controlled dept filter
  const [deptFilter,    setDeptFilter]    = useState(() => {
    try {
      const saved = localStorage.getItem('sam_dept_filter_selection')
      return saved ? new Set(JSON.parse(saved)) : new Set()
    } catch { return new Set() }
  })   // persisted multi-select department filter
  const deptFilterRef   = useRef(null)   // for click-outside detection
  const tableScrollRef  = useRef(null)                            // scroll position retention
  const [samRunStatus,  setSamRunStatus]  = useState(null)
  const [pulling,       setPulling]       = useState(false)
  const [pullMessage,   setPullMessage]   = useState(null)
  const lastAutomaticSAMCheck = useRef('')

  const handleCheckSAMChanges = async () => {
    try {
      await checkSAMChanges()
      toast?.success('SAM change check completed')
    } catch (error) {
      toast?.error(`SAM change check failed: ${error.message}`)
    }
  }

  useEffect(() => {
    Promise.all([checkSAMKeyExpired(), getSAMRunStatus()])
      .then(([expired, runStatus]) => {
        setSamKeyExpired(expired)
        setSamRunStatus(runStatus)
      })
  }, [])

  // Persist dept filter selection to localStorage
  useEffect(() => {
    try {
      localStorage.setItem('sam_dept_filter_selection', JSON.stringify([...deptFilter]))
    } catch {}
  }, [deptFilter])

  // Close dept filter when clicking outside
  useEffect(() => {
    if (!deptOpen) return
    const handler = (e) => {
      if (deptFilterRef.current && !deptFilterRef.current.contains(e.target)) {
        setDeptOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [deptOpen])

  // ── Scroll save/restore safety net ──────────────────────────────────
  // Save continuously, not only before button actions. SAM row refreshes are
  // also caused by the shared workbook poll, which otherwise has no user
  // event at which to capture the current position.
  const savedScrollTop = useRef(0)
  useLayoutEffect(() => {
    const el = tableScrollRef.current
    if (!el) return
    // Restore from the value saved before the last state update
    if (savedScrollTop.current > 0) {
      el.scrollTop = savedScrollTop.current
    }
  })

  // Call this before any state update that might re-render the table.
  const saveScroll = useCallback(() => {
    savedScrollTop.current = tableScrollRef.current?.scrollTop ?? 0
  }, [])

  // Distinct departments from all SAM opportunities (for department filter)
  const samDepartments = useMemo(() => {
    const depts = new Set()
    samOpps.forEach((o) => { const d = (o['Department'] || '').trim(); if (d) depts.add(d) })
    return [...depts].sort()
  }, [samOpps])

  const visibleSAMOpps = useMemo(() => samOpps.filter((o) => {
    const s = o.Status || 'new'
    if (s === 'dismissed') return showDismissed
    if (deptFilter.size > 0 && !deptFilter.has((o['Department'] || '').trim())) return false
    if (search.trim() && !recordMatches(o, search)) return false
    return true
  }).sort((a, b) => {
    // Default: earliest response date first
    const da = (a['Response Date'] || '').slice(0, 10)
    const db = (b['Response Date'] || '').slice(0, 10)
    if (!da && !db) return 0
    if (!da) return 1
    if (!db) return -1
    return da < db ? -1 : da > db ? 1 : 0
  }), [samOpps, showDismissed, deptFilter, search])

  const handleAddToPipeline = async (row, outlook) => {
    if (actioningRow === row._rowIndex || addingPipelineRowsRef.current.has(row._rowIndex)) return
    addingPipelineRowsRef.current.add(row._rowIndex)
    setActioningRow(row._rowIndex)
    try {
      await addToPipeline(row, outlook)
      toast?.success(outlook === 'Tracking' ? 'Added to pipeline as Tracking' : 'Added to pipeline')
    } catch (err) {
      toast?.error(`Failed: ${err.message}`)
    } finally {
      addingPipelineRowsRef.current.delete(row._rowIndex)
      setActioningRow(null)
    }
  }

  const handleDismiss = async (row) => {
    if (actioningRow === row._rowIndex) return
    setActioningRow(row._rowIndex)
    saveScroll()
    try {
      await dismiss(row._rowIndex)
    } catch (err) {
      toast?.error('Could not dismiss. Use Retry sync on this row.')
    } finally {
      setActioningRow(null)
    }
  }

  const handleBulkDismiss = async () => {
    if (selectedRows.size === 0) return
    saveScroll()
    const rowIndices = [...selectedRows]
    setSelectedRows(new Set())
    let failed = 0
    await bulkDismissAction.run(async () => {
      for (const rowIndex of rowIndices) {
        try {
          await dismiss(rowIndex)
        } catch {
          failed++
        }
      }
    })
    const dismissed = rowIndices.length - failed
    if (dismissed > 0) toast?.success(`${dismissed} opportunit${dismissed === 1 ? 'y' : 'ies'} dismissed`)
    if (failed > 0) toast?.error(`${failed} could not be dismissed. Use Retry sync on the affected rows.`)
  }

  const handleUndismiss = async (row) => {
    if (actioningRow === row._rowIndex) return
    setActioningRow(row._rowIndex)
    try {
      const pipelineRecord = pipelineByOpportunityKey.get(normalizeOpportunityKey(row['Solicitation Number'] || row['Notice ID']))
      const restoredStatus = pipelineRecord
        ? (pipelineRecord[C.outlook] === 'Tracking' ? 'tracked' : 'added_to_pipeline')
        : 'new'
      await undismiss(row._rowIndex, restoredStatus)
      toast?.success(pipelineRecord ? 'Restored as an existing pipeline opportunity' : 'Restored')
    } catch (err) {
      toast?.error(`Failed: ${err.message}`)
    } finally {
      setActioningRow(null)
    }
  }

  const handleRetryStatus = async (row) => {
    if (actioningRow === row._rowIndex) return
    setActioningRow(row._rowIndex)
    try {
      await retryStatus(row._rowIndex)
      toast?.success('Status synchronized')
    } catch (err) {
      toast?.error(`Still unable to save: ${err.message}`)
    } finally {
      setActioningRow(null)
    }
  }

  const handlePull = async ({ force = false } = {}) => {
    if (isPulling) return
    setPulling(true)
    setPullMessage(null)
    try {
      const result = await triggerPull({ force })
      if (result.throttled) {
        setPullMessage({ type: 'info', text: result.message })
      } else {
        setPullMessage(null)   // live progress display (below) takes over from here
      }
    } catch (err) {
      setPullMessage({ type: 'error', text: `Pull failed: ${err.message}` })
    } finally {
      setPulling(false)
    }
  }

  // isPulling covers both "this tab just clicked Refresh" (pulling, true only
  // for the brief initial POST) and "a pull is actively running right now"
  // (pullProgress, true for the whole run — including one auto-resumed from
  // a stalled previous session, which this component never explicitly triggered)
  const isPulling = pulling || pullProgress?.status === 'running' || pullProgress?.status === 'partial'

  const pullProgressText = (() => {
    if (!pullProgress || !['running', 'partial'].includes(pullProgress.status)) return null
    if (pullProgress.status === 'partial') return 'Continuing opportunity pull…'
    if (pullProgress.phase === 'preparing') return 'Preparing opportunity pull…'
    if (pullProgress.phase === 'writing') {
      const n = pullProgress.toWrite || 0
      return `Writing ${n} new opportunit${n === 1 ? 'y' : 'ies'} to the pipeline…`
    }
    const { naicsProcessed = 0, naicsTotal } = pullProgress
    return naicsTotal
      ? `Fetching from SAM.gov… (${naicsProcessed}/${naicsTotal} NAICS codes)`
      : 'Fetching from SAM.gov…'
  })()

  // Once a polled run reaches a terminal state, treat it as the new
  // "last pulled" summary immediately rather than waiting for the next
  // page load — pullProgress already carries the same shape samRunStatus expects.
  useEffect(() => {
    if (pullProgress?.status === 'success' || pullProgress?.status === 'error') {
      setSamRunStatus(pullProgress)
      // This is the exact transition that replaces live activity with the
      // durable Last pulled / failure summary. Clear its transient companion
      // in the same update so the two displays cannot get out of sync.
      setPullMessage(null)
    }
  }, [pullProgress])

  // Refresh remains a discovery pull. Once it has actually completed, run a
  // separate monitor pass for already-pulled opportunities. This is kept out
  // of the pull Worker path so it cannot contribute to pull timeouts.
  useEffect(() => {
    if (pullProgress?.status !== 'success' || !pullProgress.timestamp) return
    if (lastAutomaticSAMCheck.current === pullProgress.timestamp) return
    lastAutomaticSAMCheck.current = pullProgress.timestamp
    checkSAMChanges().catch((error) => console.warn('[SAM monitor]', error.message))
  }, [checkSAMChanges, pullProgress])

  // Explain a running pull accurately. Settings and the New Opportunities
  // tab share browser-local run state, so a Settings-triggered pull is not
  // described as though another user or device started it.
  useEffect(() => {
    if (!['running', 'partial'].includes(pullProgress?.status)) {
      // The running-state label is temporary. Completed and failed runs have
      // a durable summary in the status line above it.
      setPullMessage((message) => message?.type === 'info' ? null : message)
      return
    }
    if (pullProgress.status === 'partial') return
    if (pullOrigin?.source === 'settings') {
      setPullMessage({ type: 'info', text: 'A pull started from Settings is running.' })
    } else if (pullOrigin?.source === 'recovery') {
      setPullMessage({ type: 'info', text: 'Resuming an interrupted opportunity pull…' })
    } else if (!pullOrigin) {
      setPullMessage({ type: 'info', text: 'An opportunity pull is currently running.' })
    }
  }, [pullProgress, pullOrigin])

  const samStatusBadge = (status) => {
    if (status === 'added_to_pipeline') return <span className="badge badge-award"    style={{ fontSize: 10 }}>Added</span>
    if (status === 'tracked')           return <span className="badge badge-proposal" style={{ fontSize: 10 }}>Tracked</span>
    if (status === 'dismissed')         return <span className="badge badge-tracking" style={{ fontSize: 10, opacity: 0.6 }}>Dismissed</span>
    return null
  }

  const samChangeBadge = (opportunity) => {
    const change = samChangesByRow[opportunity._rowIndex]?.change
    if (!change || change.reviewedAt) return null
    return (
      <button
        className={styles.samUpdatedBadge}
        title={change.summary || 'SAM has updated this opportunity.'}
        onClick={() => markSAMChangeReviewed(opportunity).catch((error) => toast?.error(error.message))}
      >
        SAM updated
        <span className={styles.samUpdatedTooltip}>{change.summary || 'SAM has updated this opportunity.'}<br /><strong>Click to mark reviewed</strong></span>
      </button>
    )
  }

  const rfiFollowUpBadge = (opportunity) => {
    const status = rfiFollowUpStatus[String(opportunity[C.contractNum] || '').trim().toLowerCase()]
    if (!status?.badgeVisible) return null
    const seen = status.badgeState === 'seen'
    return (
      <button
        className="badge"
        style={{
          background: seen ? 'var(--gray-100)' : 'var(--blue-50)',
          border: `0.5px solid ${seen ? 'var(--gray-300)' : 'var(--blue-200)'}`,
          color: seen ? 'var(--gray-600)' : 'var(--blue-800)', cursor: 'pointer', fontSize: 10,
        }}
        title={`${status.pendingCount} possible follow-up${status.pendingCount === 1 ? '' : 's'}${seen ? ' (seen)' : ''}`}
        onClick={async (event) => {
          event.stopPropagation()
          try { await markFollowUpsSeen(opportunity[C.contractNum]) } catch {}
          openOpportunity(opportunity, { focusFollowUps: true })
        }}
      >
        {seen ? 'Follow-ups seen' : `${status.pendingCount} possible follow-up${status.pendingCount === 1 ? '' : 's'}`}
      </button>
    )
  }

  // Keep this as a render function, not an inline React component. An inline
  // <NewTab /> gets a new component identity on every parent render and makes
  // React unmount the scroll container, sending users back to the top.
  const renderNewTab = () => (
    <div>
      {samKeyExpired && (
        <div style={{
          background: 'var(--amber-50)', border: '0.5px solid var(--amber-600)',
          borderRadius: 'var(--radius-md)', padding: '10px 14px', marginBottom: 12,
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          fontSize: 13, color: 'var(--amber-600)',
        }}>
          <span>⚠️ Your SAM.gov API key may have expired. Rotate it via <code>wrangler secret put SAM_API_KEY</code>.</span>
          <button style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--amber-600)', fontSize: 16 }}
            onClick={() => setSamKeyExpired(false)}>✕</button>
        </div>
      )}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8, gap: 12, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span className="text-sm text-muted">
            {visibleSAMOpps.length} opportunit{visibleSAMOpps.length !== 1 ? 'ies' : 'y'}
            {!showDismissed && samOpps.some((o) => o.Status === 'dismissed') && (
              <> · <button className="btn btn-ghost text-xs" style={{ padding: '2px 6px' }}
                onClick={() => { saveScroll(); setShowDismissed(true) }}>Show dismissed</button></>
            )}
            {showDismissed && (
              <> · <button className="btn btn-ghost text-xs" style={{ padding: '2px 6px' }}
                onClick={() => { saveScroll(); setShowDismissed(false) }}>Hide dismissed</button></>
            )}
          </span>
          <button className="btn text-xs" style={{ padding: '3px 10px' }}
            onClick={() => handlePull()} disabled={isPulling}>
            {isPulling ? '⏳ Pulling…' : '↻ Refresh'}
          </button>
          <button className="btn text-xs" style={{ padding: '3px 10px' }}
            onClick={handleCheckSAMChanges} disabled={checkingSAMChanges || isPulling}>
            {checkingSAMChanges ? 'Checking SAM…' : 'Check SAM changes'}
          </button>
          {checkingSAMChanges && (
            <span className="text-xs" style={{ color: 'var(--blue-600)' }}>
              Checking SAM changes{samCheckProgress?.total ? `: ${samCheckProgress.checked}/${samCheckProgress.total}` : '…'}
            </span>
          )}
          {!checkingSAMChanges && samCheckError && <span className="text-xs" style={{ color: 'var(--red-600)' }}>{samCheckError}</span>}
          {/* Department filter — controlled multi-select, stays open on selection, always visible */}
          {samDepartments.length > 0 && (
            <div ref={deptFilterRef} style={{ position: 'relative' }}>
              <button className="btn text-xs" style={{ padding: '3px 10px' }}
                onClick={() => setDeptOpen((v) => !v)}>
                🏛 Dept{deptFilter.size > 0 ? ` (${deptFilter.size})` : ''}
              </button>
              {deptOpen && (
                <div className={styles.deptDropdown}>
                  <div style={{ padding: '6px 10px', borderBottom: '0.5px solid var(--gray-100)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span className="text-xs text-muted">Filter by department</span>
                    {deptFilter.size > 0 && (
                      <button className="text-xs" style={{ background: 'none', border: 'none', color: 'var(--blue-600)', cursor: 'pointer', padding: 0, fontFamily: 'var(--font)' }}
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => setDeptFilter(new Set())}>Clear</button>
                    )}
                  </div>
                  {samDepartments.map((dept) => (
                    <label key={dept} className={styles.deptOption}
                      onMouseDown={(e) => e.preventDefault()}>
                      <input type="checkbox"
                        checked={deptFilter.has(dept)}
                        onChange={() => {
                          setDeptFilter((prev) => {
                            const next = new Set(prev)
                            next.has(dept) ? next.delete(dept) : next.add(dept)
                            return next
                          })
                        }}
                      />
                      <span className="text-xs">{dept}</span>
                    </label>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2 }}>
          {isPulling && pullProgressText
            ? (
              <span className="text-xs" style={{ color: 'var(--blue-600)', display: 'flex', alignItems: 'center', gap: 6 }}>
                <span className={styles.spinnerDot} aria-hidden="true" />
                {pullProgressText}
              </span>
            )
            : (
              <span className="text-xs text-muted">
                {samRunStatus?.success === true && (
                  <>
                    {`Last pulled: ${new Date(samRunStatus.timestamp).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`}
                    {samRunStatus.written > 0
                      ? <> · {samRunStatus.written} new total</>
                      : <> · No new opportunities found</>}
                    {samRunStatus.deduped > 0 && <> · {samRunStatus.deduped} duplicate{samRunStatus.deduped === 1 ? '' : 's'} removed</>}
                    {samRunStatus.warnings?.length > 0 && (
                      <span style={{ color: 'var(--amber-600)' }} title={samRunStatus.warnings.join('\n')}>
                        {' '}· ⚠ {samRunStatus.warnings.length} warning{samRunStatus.warnings.length === 1 ? '' : 's'}
                      </span>
                    )}
                  </>
                )}
                {samRunStatus?.status === 'partial' && (
                  <span style={{ color: 'var(--blue-600)' }}>
                    Pull checkpoint saved · {samRunStatus.written || 0} new total · continues at the next scheduled pull
                  </span>
                )}
                {samRunStatus?.success === false && samRunStatus?.status !== 'partial' && (
                  <span style={{ color: 'var(--red-600)' }} title={samRunStatus.warnings?.join('\n') || ''}>
                    Last run failed: {samRunStatus.error || 'No error detail was recorded.'}
                  </span>
                )}
                {samRunStatus?.success == null && 'Not yet pulled'}
              </span>
            )
          }
          {pullMessage && (
            <span style={{ fontSize: 11, color: pullMessage.type === 'error' ? 'var(--red-600)' : pullMessage.type === 'success' ? 'var(--green-600)' : 'var(--gray-600)' }}>
              {pullMessage.text}
            </span>
          )}
        </div>
      </div>
      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        {samLoading
          ? <div style={{ padding: 20 }}><div className="skeleton" style={{ height: 200 }} /></div>
          : visibleSAMOpps.length === 0
            ? (
              <div className={styles.empty}>
                <div style={{ fontSize: 28, marginBottom: 8, opacity: 0.3 }}>◈</div>
                <div style={{ fontWeight: 600, fontSize: 14, color: 'var(--gray-900)', marginBottom: 4 }}>
                  {samOpps.length === 0 ? 'No new opportunities yet' : 'Nothing to show'}
                </div>
                <div style={{ fontSize: 13, color: 'var(--gray-400)', maxWidth: 360 }}>
                  {samOpps.length === 0
                    ? 'Use Refresh to pull opportunities from SAM.gov that match your NAICS codes.'
                    : 'All opportunities have been dismissed. Toggle "Show dismissed" to see them.'}
                </div>
              </div>
            )
            : (
              <div
                ref={tableScrollRef}
                onScroll={(event) => { savedScrollTop.current = event.currentTarget.scrollTop }}
                style={{ overflowX: 'auto', overflowY: 'auto', maxHeight: 'calc(100vh - var(--topbar-height) - 100px)' }}
              >
                <table className="data-table" style={{ borderCollapse: 'separate', borderSpacing: 0 }}>
                  <thead style={{ position: 'sticky', top: 0, zIndex: 2 }}>
                    <tr>
                      <th style={{ width: 28, position: 'sticky', top: 0, background: 'var(--gray-50)', boxShadow: '0 1px 0 var(--gray-200)', padding: '8px 4px' }}>
                        <input type="checkbox"
                          style={{ cursor: 'pointer' }}
                          checked={selectedRows.size > 0 && visibleSAMOpps.filter(o => o.Status !== 'dismissed').every(o => selectedRows.has(o._rowIndex))}
                          onChange={(e) => {
                            const actionable = visibleSAMOpps.filter(o => o.Status !== 'dismissed').map(o => o._rowIndex)
                            setSelectedRows(e.target.checked ? new Set(actionable) : new Set())
                          }}
                          title="Select all"
                        />
                      </th>
                      <th style={{ position: 'sticky', top: 0, background: 'var(--gray-50)', boxShadow: '0 1px 0 var(--gray-200)' }}>Title</th>
                      <th style={{ position: 'sticky', top: 0, background: 'var(--gray-50)', boxShadow: '0 1px 0 var(--gray-200)' }}>Agency</th>
                      <th style={{ position: 'sticky', top: 0, background: 'var(--gray-50)', boxShadow: '0 1px 0 var(--gray-200)' }}>NAICS</th>
                      <th style={{ position: 'sticky', top: 0, background: 'var(--gray-50)', boxShadow: '0 1px 0 var(--gray-200)' }}>Response Date</th>
                      <th style={{ position: 'sticky', top: 0, background: 'var(--gray-50)', boxShadow: '0 1px 0 var(--gray-200)' }}>POC</th>
                      <th style={{ width: 160, position: 'sticky', top: 0, background: 'var(--gray-50)', boxShadow: '0 1px 0 var(--gray-200)' }}>
                        {(selectedRows.size > 0 || bulkDismissAction.isLoading)
                          ? <button style={{ fontSize: '10.5px', padding: '2px 8px', background: 'var(--red-600)', color: 'var(--text-on-brand)', border: 'none', borderRadius: 'var(--radius-md)', cursor: bulkDismissAction.isLoading ? 'default' : 'pointer', fontFamily: 'var(--font)', fontWeight: 500, opacity: bulkDismissAction.isLoading ? 0.7 : 1 }}
                              disabled={bulkDismissAction.isLoading}
                              onClick={handleBulkDismiss}>
                              {bulkDismissAction.isLoading ? 'Dismissing…' : `Dismiss ${selectedRows.size} selected`}
                            </button>
                          : 'Actions'
                        }
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleSAMOpps.map((opp) => {
                      const isDismissed = opp.Status === 'dismissed'
                      const isActioned  = ['added_to_pipeline', 'tracked'].includes(opp.Status)
                      const syncFailure = failedStatuses[opp._rowIndex]
                      const linkedOpportunity = pipelineByOpportunityKey.get(
                        normalizeOpportunityKey(opp['Solicitation Number'] || opp['Notice ID'])
                      )
                      const isActioning = actioningRow === opp._rowIndex
                      const pocDisplay  = (opp['Point of Contact'] || '').split('|')[0].trim()
                      // All buttons same size, text centered
                      const btnSm = { padding: '3px 6px', fontSize: '10.5px', textAlign: 'center', justifyContent: 'center' }
                      return (
                        <tr key={opp['Notice ID']}
                          style={{ opacity: isDismissed ? 0.55 : 1 }}>
                          <td className={styles.checkCell} onClick={(e) => e.stopPropagation()}>
                            <input type="checkbox"
                              className={`${styles.rowCheckbox} ${selectedRows.has(opp._rowIndex) ? styles.rowCheckboxVisible : ''}`}
                              style={{ cursor: 'pointer' }}
                              checked={selectedRows.has(opp._rowIndex)}
                              onChange={() => {
                                if (isDismissed) return
                                saveScroll()
                                setSelectedRows((prev) => {
                                  const next = new Set(prev)
                                  next.has(opp._rowIndex) ? next.delete(opp._rowIndex) : next.add(opp._rowIndex)
                                  return next
                                })
                              }}
                            />
                          </td>
						  <td style={{ fontWeight: 500 }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                              {opp['Title']}
                              {samStatusBadge(opp.Status)}
                              {samChangeBadge(opp)}
                              {syncFailure && <span className="badge badge-closed-lost" style={{ fontSize: 10 }}>Sync failed</span>}
                            </div>
                          </td>
                          <td className="text-sm text-muted">{opp['Agency'] || '—'}</td>
                          <td className="text-xs text-muted">{opp['NAICS Code'] || '—'}</td>
                          <td className="text-sm">{formatDateTime(opp['Response Date'])}</td>
                          <td className="text-xs text-muted" style={{ maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {pocDisplay || '—'}
                          </td>
                          <td onClick={(e) => e.stopPropagation()}>
                            {isDismissed
                              ? (
                                <div style={{ display: 'grid', gridTemplateColumns: syncFailure ? '1fr 1fr' : '1fr', gap: 4 }}>
                                  <button className="btn" style={btnSm}
                                    disabled={isActioning} onClick={() => handleUndismiss(opp)}>
                                    {isActioning ? '…' : 'Restore'}
                                  </button>
                                  {syncFailure && (
                                    <button className={`btn ${styles.newActionSam}`} style={btnSm}
                                      title={syncFailure.message} disabled={isActioning} onClick={() => handleRetryStatus(opp)}>
                                      {isActioning ? '…' : 'Retry sync'}
                                    </button>
                                  )}
                                </div>
                              )
                              : (
                                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4 }}>
                                  {!isActioned && (
                                    <>
                                      {/* Row 1: + Pipeline (green) | Track (amber/white) */}
                                      <button className={`btn btn-primary ${styles.newActionPipeline}`} style={btnSm}
                                        disabled={isActioning} onClick={() => handleAddToPipeline(opp, 'New')}>
                                        {isActioning ? '…' : '+ Pipeline'}
                                      </button>
                                      <button className={`${styles.newAction} ${styles.newActionTrack}`} style={btnSm}
                                        disabled={isActioning} onClick={() => handleAddToPipeline(opp, 'Tracking')}>
                                        {isActioning ? '…' : 'Track'}
                                      </button>
                                      {/* Row 2: Dismiss (red/white) | SAM.gov (blue) */}
                                      <button className={`${styles.newAction} ${styles.newActionDismiss}`} style={btnSm}
                                        disabled={isActioning} onClick={() => handleDismiss(opp)}>
                                        Dismiss
                                      </button>
                                    </>
                                  )}
                                  {isActioned && linkedOpportunity && (
                                    <button className={`btn ${styles.newActionPipeline}`} style={btnSm}
                                      onClick={() => openOpportunity(linkedOpportunity)}>
                                      View pipeline
                                    </button>
                                  )}
                                  {syncFailure && (
                                    <button className={`btn ${styles.newActionSam}`} style={btnSm}
                                      title={syncFailure.message} disabled={isActioning} onClick={() => handleRetryStatus(opp)}>
                                      {isActioning ? '…' : 'Retry sync'}
                                    </button>
                                  )}
                                  {opp['SAM.gov URL'] && (
                                    <a href={opp['SAM.gov URL']} target="_blank" rel="noreferrer"
                                      className={`${styles.newAction} ${styles.newActionSam}`} style={{ ...btnSm, textDecoration: 'none' }}>
                                      SAM.gov
                                    </a>
                                  )}
                                </div>
                              )
                            }
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )
        }
      </div>
    </div>
  )

  // ── Sort icon ─────────────────────────────────────────────────────────
  const SortIcon = ({ col }) => (
    <span className={styles.sortIcon} aria-hidden="true">
      {sortKey === col ? (sortDir === 'asc' ? '↑' : '↓') : '↕'}
    </span>
  )

  // ── Empty state message ───────────────────────────────────────────────
  const emptyMsg = search
    ? `No opportunities match "${search}".`
    : activeFilterCount > 0
      ? 'No opportunities match the current filters.'
      : {
          All:      'No opportunities in the pipeline yet.',
          RFIs:     'No RFIs yet. Opportunities appear here when Phase is Identified and Outlook is New.',
          Expiring: 'No expiring contracts yet. Set an opportunity\'s Outlook to Expiring to track it here.',
          Tracked:  'Nothing tracked yet. Use the Track button on new opportunities, or set an opportunity\'s Outlook to Tracking.',
          New:      '',
        }[activeTab]

  // ── Table renderers (one per tab) ─────────────────────────────────────

  const AllTable = () => (
    <table className="data-table">
      <thead>
        <tr>
          <th onClick={() => handleSort(C.title)} style={{ cursor: 'pointer' }}>Title <SortIcon col={C.title} /></th>
          <th>Contract #</th>
          <th onClick={() => handleSort(C.phase)} style={{ cursor: 'pointer' }}>Phase <SortIcon col={C.phase} /></th>
          <th onClick={() => handleSort(C.outlook)} style={{ cursor: 'pointer' }}>Outlook <SortIcon col={C.outlook} /></th>
          <th onClick={() => handleSort(C.agency)} style={{ cursor: 'pointer' }}>Agency <SortIcon col={C.agency} /></th>
          <th onClick={() => handleSort(C.priority)} style={{ cursor: 'pointer' }}>Priority <SortIcon col={C.priority} /></th>
          <th onClick={() => handleSort(C.value)} style={{ cursor: 'pointer' }}>Value <SortIcon col={C.value} /></th>
          <th onClick={() => handleSort(C.lastMod)} style={{ cursor: 'pointer' }}>Last modified <SortIcon col={C.lastMod} /></th>
          <th />
        </tr>
      </thead>
      <tbody>
        {filtered.map((opp) => {
          const cn = opp[C.contractNum]
          return (
            <tr key={`${cn}-${opp._rowIndex}`}
              onClick={() => openOpportunity(opp)}>
              <td style={{ fontWeight: 500, maxWidth: 240 }}>{opp[C.title]}</td>
              <td className="text-xs text-muted" style={{ whiteSpace: 'nowrap' }}>{cn}</td>
              <td>
                <span className={`badge ${PHASE_BADGE[opp[C.phase]] || 'badge-tracking'}`}>
                  {opp[C.phase] || '—'}
                </span>
              </td>
              <td className="text-sm text-muted">{opp[C.outlook] || '—'}</td>
              <td className="text-sm text-muted">{opp[C.agency] || '—'}</td>
              <td className="text-sm">
                {opp[C.priority]
                  ? <span className={`badge ${PRIORITY_BADGE[opp[C.priority]] || 'badge-tracking'}`}>{opp[C.priority]}</span>
                  : <span className="text-muted">—</span>}
              </td>
              <td className="text-sm">{fmtValue(opp[C.value])}</td>
              <td className="text-sm text-muted">{formatDate(opp[C.lastMod])}</td>
              <td>
                <button
                  className="btn btn-ghost btn-icon"
                  aria-label="Delete"
                  title="Delete"
                  onClick={(e) => { e.stopPropagation(); setConfirmDelete(opp) }}
                >✕</button>
              </td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )

  const RFIsTable = () => (
    <table className="data-table">
      <thead>
        <tr>
          <th onClick={() => handleSort(C.title)} style={{ cursor: 'pointer' }}>Title <SortIcon col={C.title} /></th>
          <th>Contract #</th>
          <th onClick={() => handleSort(C.agency)} style={{ cursor: 'pointer' }}>Agency <SortIcon col={C.agency} /></th>
          <th onClick={() => handleSort(C.submDate)} style={{ cursor: 'pointer' }}>Submission date <SortIcon col={C.submDate} /></th>
        </tr>
      </thead>
      <tbody>
        {filtered.map((opp) => {
          const cn = opp[C.contractNum]
          return (
            <tr key={`${cn}-${opp._rowIndex}`}
              onClick={() => openOpportunity(opp)}>
              <td style={{ fontWeight: 500, maxWidth: 300 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                  <span>{opp[C.title]}</span>{rfiFollowUpBadge(opp)}
                </div>
              </td>
              <td className="text-xs text-muted" style={{ whiteSpace: 'nowrap' }}>{cn}</td>
              <td className="text-sm text-muted">{opp[C.agency] || '—'}</td>
              <td className={`text-sm ${opp[C.submDate] ? '' : 'text-muted'}`}>
                {opp[C.submDate] ? formatDate(opp[C.submDate]) : '—'}
              </td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )

  const ExpiringTable = () => (
    <table className="data-table">
      <thead>
        <tr>
          <th onClick={() => handleSort(C.title)} style={{ cursor: 'pointer' }}>Title <SortIcon col={C.title} /></th>
          <th>Contract #</th>
          <th onClick={() => handleSort(C.agency)} style={{ cursor: 'pointer' }}>Agency <SortIcon col={C.agency} /></th>
          <th onClick={() => handleSort(C.value)} style={{ cursor: 'pointer' }}>Value <SortIcon col={C.value} /></th>
          <th onClick={() => handleSort(C.endDate)} style={{ cursor: 'pointer' }}>Contract end date <SortIcon col={C.endDate} /></th>
          <th onClick={() => handleSort(C.lastMod)} style={{ cursor: 'pointer' }}>Last modified <SortIcon col={C.lastMod} /></th>
          <th />
        </tr>
      </thead>
      <tbody>
        {filtered.map((opp) => {
          const cn = opp[C.contractNum]
          return (
            <tr key={`${cn}-${opp._rowIndex}`}
              onClick={() => openOpportunity(opp)}>
              <td style={{ fontWeight: 500, maxWidth: 260 }}>{opp[C.title]}</td>
              <td className="text-xs text-muted" style={{ whiteSpace: 'nowrap' }}>{cn}</td>
              <td className="text-sm text-muted">{opp[C.agency] || '—'}</td>
              <td className="text-sm">{fmtValue(opp[C.value])}</td>
              <td className={`text-sm ${opp[C.endDate] ? '' : 'text-muted'}`}>
                {opp[C.endDate] ? formatDate(opp[C.endDate]) : '—'}
              </td>
              <td className="text-sm text-muted">{formatDate(opp[C.lastMod])}</td>
              <td>
                <button
                  className="btn btn-ghost btn-icon"
                  aria-label="Delete"
                  title="Delete"
                  onClick={(e) => { e.stopPropagation(); setConfirmDelete(opp) }}
                >✕</button>
              </td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )

  const TrackedTable = () => (
    <table className="data-table">
      <thead>
        <tr>
          <th onClick={() => handleSort(C.title)} style={{ cursor: 'pointer' }}>Title <SortIcon col={C.title} /></th>
          <th>Contract #</th>
          <th onClick={() => handleSort(C.phase)} style={{ cursor: 'pointer' }}>Phase <SortIcon col={C.phase} /></th>
          <th onClick={() => handleSort(C.agency)} style={{ cursor: 'pointer' }}>Agency <SortIcon col={C.agency} /></th>
          <th onClick={() => handleSort(C.value)} style={{ cursor: 'pointer' }}>Value <SortIcon col={C.value} /></th>
          <th onClick={() => handleSort(C.lastMod)} style={{ cursor: 'pointer' }}>Last modified <SortIcon col={C.lastMod} /></th>
          <th />
        </tr>
      </thead>
      <tbody>
        {filtered.map((opp) => {
          const cn = opp[C.contractNum]
          return (
            <tr key={`${cn}-${opp._rowIndex}`}
              onClick={() => openOpportunity(opp)}>
              <td style={{ fontWeight: 500, maxWidth: 260 }}>{opp[C.title]}</td>
              <td className="text-xs text-muted" style={{ whiteSpace: 'nowrap' }}>{cn}</td>
              <td>
                <span className={`badge ${PHASE_BADGE[opp[C.phase]] || 'badge-tracking'}`}>
                  {opp[C.phase]}
                </span>
              </td>
              <td className="text-sm text-muted">{opp[C.agency] || '—'}</td>
              <td className="text-sm">{fmtValue(opp[C.value])}</td>
              <td className="text-sm text-muted">{formatDate(opp[C.lastMod])}</td>
              <td>
                <button
                  className="btn btn-ghost btn-icon"
                  aria-label="Delete"
                  title="Delete"
                  onClick={(e) => { e.stopPropagation(); setConfirmDelete(opp) }}
                >✕</button>
              </td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )

  // ── Render ────────────────────────────────────────────────────────────
  return (
    <>
      <Topbar
        title="Opportunities"
        subtitle1={`${activeTab === 'New' ? visibleSAMOpps.length : filtered.length} shown`}
        showFilter={activeTab !== 'New'}
        showNew={true}
        newLabel="New opportunity"
        onNew={() => setShowAdd(true)}
        onFilter={() => setShowFilter((v) => !v)}
      />
      <div className="page-body">

        {/* ── Tabs ── */}
        <div className={styles.tabRow}>
          {TABS.map((tab) => (
            <button
              key={tab}
              className={`${styles.tab} ${activeTab === tab ? styles.tabActive : ''}`}
              onClick={() => handleTabChange(tab)}
            >
              {tab}
              {tab !== 'New' && tabCounts[tab] > 0 && (
                <span className={styles.tabBadge}>{tabCounts[tab]}</span>
              )}
            </button>
          ))}
        </div>

        {/* ── Search bar ── */}
        <div className={styles.searchBar}>
            <span className={styles.searchIcon} aria-hidden="true">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
              </svg>
            </span>
            <input
              className={styles.searchInput}
              placeholder={activeTab === 'New' ? 'Search all SAM opportunity fields…' : 'Search all opportunity fields and linked notes…'}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label="Search opportunities"
            />
            {search && (
              <button className={styles.searchClear} onClick={() => setSearch('')} aria-label="Clear search">✕</button>
            )}
        </div>

        {/* ── Advanced filter panel ── */}
        {showFilter && activeTab !== 'New' && (
          <div className={styles.filterPanel}>
            <div className={styles.filterGrid}>
              <div className="form-field">
                <label className="form-label">Outlook</label>
                <select className="form-input" value={filters.outlook}
                  onChange={(e) => setFilters((f) => ({ ...f, outlook: e.target.value }))}>
                  <option value="">All</option>
                  {outlookOptions.map((o) => <option key={o}>{o}</option>)}
                </select>
              </div>
              <div className="form-field">
                <label className="form-label">Priority</label>
                <select className="form-input" value={filters.priority}
                  onChange={(e) => setFilters((f) => ({ ...f, priority: e.target.value }))}>
                  <option value="">All</option>
                  {priorityOptions.map((p) => <option key={p}>{p}</option>)}
                </select>
              </div>
              <div className="form-field">
                <label className="form-label">Set-Aside</label>
                <select className="form-input" value={filters.setAside}
                  onChange={(e) => setFilters((f) => ({ ...f, setAside: e.target.value }))}>
                  <option value="">All</option>
                  {setAsideOptions.map((s) => <option key={s}>{s}</option>)}
                </select>
              </div>
              <div className="form-field">
                <label className="form-label">Bid / No Bid</label>
                <select className="form-input" value={filters.bidNoBid}
                  onChange={(e) => setFilters((f) => ({ ...f, bidNoBid: e.target.value }))}>
                  <option value="">All</option>
                  {bidNoBidOptions.map((b) => <option key={b}>{b}</option>)}
                </select>
              </div>
              <div className="form-field" ref={agencyFilterRef} style={{ position: 'relative' }}>
                <label className="form-label">Agency</label>
                <button
                  type="button"
                  className="form-input"
                  style={{ textAlign: 'left', cursor: 'pointer', background: 'var(--surface)' }}
                  onClick={() => setAgencyFilterOpen((v) => !v)}
                >
                  {filters.agency.size === 0
                    ? 'All'
                    : filters.agency.size === 1
                      ? [...filters.agency][0]
                      : `${filters.agency.size} selected`}
                </button>
                {agencyFilterOpen && (
                  <div className={styles.deptDropdown}>
                    {tabAgencies.length === 0
                      ? <div style={{ padding: '8px 12px' }} className="text-xs text-muted">No agencies in this view.</div>
                      : tabAgencies.map((ag) => (
                        <label key={ag} className={styles.deptOption}
                          onMouseDown={(e) => e.preventDefault()}>
                          <input type="checkbox"
                            checked={filters.agency.has(ag)}
                            onChange={() => {
                              setFilters((f) => {
                                const next = new Set(f.agency)
                                next.has(ag) ? next.delete(ag) : next.add(ag)
                                return { ...f, agency: next }
                              })
                            }}
                          />
                          <span className="text-xs">{ag}</span>
                        </label>
                      ))
                    }
                  </div>
                )}
              </div>
              <div className="form-field">
                <label className="form-label">Assigned To</label>
                <select className="form-input" value={filters.assignedTo}
                  onChange={(e) => setFilters((f) => ({ ...f, assignedTo: e.target.value }))}>
                  <option value="">All</option>
                  {assigneeOptions.map((a) => <option key={a}>{a}</option>)}
                </select>
              </div>
              <div className="form-field">
                <label className="form-label">Phase</label>
                <select className="form-input" value={filters.phase}
                  onChange={(e) => setFilters((f) => ({ ...f, phase: e.target.value }))}>
                  <option value="">All</option>
                  {phaseOptions.map((p) => <option key={p}>{p}</option>)}
                </select>
              </div>
              <div className="form-field">
                <label className="form-label">Prime / Sub</label>
                <select className="form-input" value={filters.primeOrSub}
                  onChange={(e) => setFilters((f) => ({ ...f, primeOrSub: e.target.value }))}>
                  <option value="">All</option>
                  {primeOrSubOptions.map((p) => <option key={p}>{p}</option>)}
                </select>
              </div>
              <div className="form-field">
                <label className="form-label">Classification</label>
                <select className="form-input" value={filters.classification}
                  onChange={(e) => setFilters((f) => ({ ...f, classification: e.target.value }))}>
                  <option value="">All</option>
                  {classificationOptions.map((c) => <option key={c}>{c}</option>)}
                </select>
              </div>
              <div className="form-field">
                <label className="form-label">Contract Vehicle</label>
                <select className="form-input" value={filters.vehicle}
                  onChange={(e) => setFilters((f) => ({ ...f, vehicle: e.target.value }))}>
                  <option value="">All</option>
                  {vehicleOptions.map((v) => <option key={v}>{v}</option>)}
                </select>
              </div>
              <div className="form-field">
                <label className="form-label">Expiring</label>
                <select className="form-input" value={filters.endBand}
                  onChange={(e) => setFilters((f) => ({ ...f, endBand: e.target.value }))}>
                  <option value="">All</option>
                  {EXPIRING_BANDS.map((b) => <option key={b.key} value={b.key}>{b.label}</option>)}
                </select>
              </div>
            </div>
            {activeFilterCount > 0 && (
              <button className="btn btn-ghost text-sm"
                style={{ marginTop: 8, color: 'var(--red-600)' }}
                onClick={() => updateParams({
                  outlook: '', priority: '', assignedTo: '', agency: new Set(), setAside: '', bidNoBid: '',
                  phase: '', primeOrSub: '', endBand: '', endYear: '', rfiMonth: '', classification: '', vehicle: '',
                })}>
                Clear all filters ({activeFilterCount})
              </button>
            )}
          </div>
        )}

        {/* Active filter chips */}
        {activeFilterCount > 0 && activeTab !== 'New' && (
          <div className="filter-chips" style={{ marginBottom: 8 }}>
            {rfiFollowUpIds.size > 0 && (
              <button className="filter-chip active" onClick={() => updateParams({ rfiFollowUps: '' })}>
                RFI follow-ups ✕
              </button>
            )}
            {Object.entries(filters).filter(([k, v]) => k === 'agency' ? false : v).map(([key, val]) => (
              <button key={key}
                className="filter-chip active"
                onClick={() => setFilters((f) => ({ ...f, [key]: '' }))}>
                {filterChipLabel(key, val)} ✕
              </button>
            ))}
            {[...filters.agency].map((ag) => (
              <button key={`agency-${ag}`}
                className="filter-chip active"
                onClick={() => setFilters((f) => {
                  const next = new Set(f.agency)
                  next.delete(ag)
                  return { ...f, agency: next }
                })}>
                {ag} ✕
              </button>
            ))}
          </div>
        )}

        {/* ── New tab: SAM.gov opportunities ── */}
        {activeTab === 'New' && renderNewTab()}

        {/* ── Pipeline tabs: RFIs / Expiring / Tracked ── */}
        {activeTab !== 'New' && (
          <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
            {loading
              ? <div style={{ padding: 20 }}><div className="skeleton" style={{ height: 200 }} /></div>
              : filtered.length === 0
                ? <div className={styles.empty}>{emptyMsg}</div>
                : (
                  <div style={{ overflowX: 'auto' }}>
                    {activeTab === 'All'      && <AllTable />}
                    {activeTab === 'RFIs'     && <RFIsTable />}
                    {activeTab === 'Expiring' && <ExpiringTable />}
                    {activeTab === 'Tracked'  && <TrackedTable />}
                  </div>
                )
            }
          </div>
        )}
      </div>

      {/* ── New opportunity modal ── */}
      {showAdd && (
        <Modal
          title="New opportunity"
          onClose={() => !saving && setShowAdd(false)}
          footer={
            <>
              <button className="btn" onClick={() => setShowAdd(false)} disabled={saving}>Cancel</button>
              <button className="btn btn-primary" onClick={requestAdd} disabled={saving} aria-busy={saving}>
                {saving ? 'Saving…' : 'Add opportunity'}
              </button>
            </>
          }
        >
          <form onSubmit={handleAdd}>
            <div className={styles.formGrid}>
              <div className="form-field" style={{ gridColumn: '1 / -1' }}>
                <label className="form-label">Project Title / Description *</label>
                <input className="form-input" required
                  value={form[C.title]}
                  onChange={(e) => setForm({ ...form, [C.title]: e.target.value })} />
              </div>
              <div className="form-field">
                <label className="form-label">Contract Number / Notice ID *</label>
                <input className="form-input" required
                  value={form[C.contractNum]}
                  onChange={(e) => setForm({ ...form, [C.contractNum]: e.target.value })} />
              </div>
              <div className="form-field">
                <label className="form-label">Solicitation Number</label>
                <input className="form-input"
                  value={form[C.solNum]}
                  onChange={(e) => setForm({ ...form, [C.solNum]: e.target.value })} />
              </div>
              <div className="form-field">
                <label className="form-label">Department</label>
                <input className="form-input"
                  value={form[C.department]}
                  onChange={(e) => setForm({ ...form, [C.department]: e.target.value })} />
              </div>
              <div className="form-field">
                <label className="form-label">Agency</label>
                <input className="form-input"
                  value={form[C.agency]}
                  onChange={(e) => setForm({ ...form, [C.agency]: e.target.value })} />
              </div>
              <div className="form-field">
                <label className="form-label">TAG Opportunity Phase</label>
                <select className="form-input"
                  value={form[C.phase]}
                  onChange={(e) => setForm({ ...form, [C.phase]: e.target.value })}>
                  {phaseOptions.map((p) => <option key={p}>{p}</option>)}
                </select>
              </div>
              <div className="form-field">
                <label className="form-label">Opportunity Outlook</label>
                <select className="form-input"
                  value={form[C.outlook]}
                  onChange={(e) => setForm({ ...form, [C.outlook]: e.target.value })}>
                  {outlookOptions.map((o) => <option key={o}>{o}</option>)}
                </select>
              </div>
              <div className="form-field">
                <label className="form-label">Total Contract Value ($)</label>
                <input className="form-input" type="number"
                  value={form[C.value]}
                  onChange={(e) => setForm({ ...form, [C.value]: e.target.value })} />
              </div>
              <div className="form-field">
                <label className="form-label">NAICS Code</label>
                <input className="form-input"
                  value={form[C.naics]}
                  onChange={(e) => setForm({ ...form, [C.naics]: e.target.value })} />
              </div>
              <div className="form-field">
                <label className="form-label">Assigned To</label>
                <select className="form-input"
                  value={form[C.assignedTo]}
                  onChange={(e) => setForm({ ...form, [C.assignedTo]: e.target.value })}>
                  <option value="">— Select —</option>
                  {assigneeOptions.map((a) => <option key={a}>{a}</option>)}
                </select>
              </div>
              <div className="form-field">
                <label className="form-label">Priority</label>
                <select className="form-input"
                  value={form[C.priority]}
                  onChange={(e) => setForm({ ...form, [C.priority]: e.target.value })}>
                  {priorityOptions.map((p) => <option key={p}>{p}</option>)}
                </select>
              </div>
              <div className="form-field">
                <label className="form-label">Set-Aside</label>
                <select className="form-input"
                  value={form[C.setAside]}
                  onChange={(e) => setForm({ ...form, [C.setAside]: e.target.value })}>
                  {setAsideOptions.map((s) => <option key={s}>{s}</option>)}
                </select>
              </div>
              {form[C.phase] === 'Identified' && form[C.outlook] === 'New' && (
                <div className="form-field">
                  <label className="form-label">RFI Submission Date</label>
                  <input className="form-input" type="date"
                    value={form[C.submDate]}
                    onChange={(e) => setForm({ ...form, [C.submDate]: e.target.value })} />
                </div>
              )}
            </div>
          </form>
        </Modal>
      )}

      {confirmRfiActivity && (
        <Modal
          title="Update activity phase?"
          onClose={() => setConfirmRfiActivity(false)}
          footer={
            <>
              <button className="btn" onClick={() => {
                setConfirmRfiActivity(false)
                submitOpp()
              }}>Not now</button>
              <button className="btn btn-primary" onClick={() => {
                setConfirmRfiActivity(false)
                submitOpp({ setSubmittedRfi: true })
              }}>Set to Submitted RFI</button>
            </>
          }
        >
          <p className="text-sm">An RFI submission date was entered. Update the Activity Phase to Submitted RFI?</p>
        </Modal>
      )}

      {/* ── Delete confirmation modal ── */}
      {confirmDelete && (
        <Modal
          title="Delete opportunity"
          onClose={() => !deleteAction.isLoading && setConfirmDelete(null)}
          footer={
            <>
              <button className="btn" onClick={() => setConfirmDelete(null)} disabled={deleteAction.isLoading}>Cancel</button>
              <button className="btn btn-danger" onClick={handleDelete} disabled={deleteAction.isLoading}>
                {deleteAction.isLoading ? 'Deleting…' : 'Delete'}
              </button>
            </>
          }
        >
          <p className="text-sm">
            Delete <strong>{confirmDelete[C.title]}</strong> ({confirmDelete[C.contractNum]})?
            This cannot be undone.
          </p>
        </Modal>
      )}
    </>
  )
}
