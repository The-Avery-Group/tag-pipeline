import { useState, useMemo, useEffect, useLayoutEffect, useRef, useCallback } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { usePipeline } from '@/hooks/usePipeline'
import { useValidationLists, pickList } from '@/hooks/useValidationLists'
import { useSAMOpportunities, checkSAMKeyExpired, getSAMRunStatus } from '@/hooks/useSAMOpportunities'
import { useAsyncAction } from '@/hooks/useAsyncAction'
import { useScrollRestoration } from '@/hooks/useScrollRestoration'
import Topbar from '@/components/Layout/Topbar'
import Modal from '@/components/Common/Modal'
import { formatDate, formatDateTime, getEndDateBand, EXPIRING_BANDS } from '@/utils/kpiHelpers'
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
  RFIs:     { key: C.lastMod,  dir: 'desc' },
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

// ── Main component ────────────────────────────────────────────────────────
export default function Opportunities({ toast }) {
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const { pipeline, loading, add, remove } = usePipeline()
  const { lists } = useValidationLists()
  useScrollRestoration()   // restores page scroll position on back-navigation from a detail page

  const outlookOptions        = pickList(lists, 'Opportunity Outlook', OPPORTUNITY_OUTLOOK)
  const priorityOptions       = pickList(lists, 'Priority', PRIORITY_VALUES)
  const setAsideOptions       = pickList(lists, 'Set-Aside', SET_ASIDE_VALUES)
  const bidNoBidOptions       = pickList(lists, 'Bid / No Bid?', ['Bid', 'No Bid', 'TBD'])
  const phaseOptions          = pickList(lists, 'TAG Opportunity Phase', OPPORTUNITY_PHASES)
  const primeOrSubOptions     = pickList(lists, 'Prime or Sub?', ['Prime', 'Sub'])
  const assigneeOptions       = pickList(lists, 'Assignee', ASSIGNEE_VALUES)

  // ── URL-param-driven list state ─────────────────────────────────────────
  // Active tab, search text, and every filter live in the URL rather than
  // component state. This does double duty: filters persist across
  // navigation (leave the page, come back, still filtered), AND any other
  // page can link directly into a pre-filtered, visibly-active view (e.g. a
  // Dashboard chart segment linking to /opportunities?tab=All&phase=Proposal
  // shows real, dismissible filter chips exactly as if applied manually).
  const activeTab = searchParams.get('tab') || 'RFIs'
  const search    = searchParams.get('search') || ''

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
    .filter(([k, v]) => k === 'agency' ? v.size > 0 : Boolean(v)).length
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

  // ── Filtered + sorted rows for the active tab ─────────────────────────
  const filtered = useMemo(() => {
    if (activeTab === 'New') return []

    let rows = getTabRows(pipeline, activeTab)

    if (search.trim()) {
      const q = search.trim().toLowerCase()
      rows = rows.filter((o) =>
        [o[C.title], o[C.contractNum], o[C.agency], o[C.department],
         o[C.assignedTo], o[C.solNum], o[C.naics], o[C.poc]]
          .some((v) => v && String(v).toLowerCase().includes(q))
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
  }, [pipeline, activeTab, search, filters, sortKey, sortDir])

  // ── Tab switch — keep search + filters (they persist across tabs now,
  //    same as they persist across navigation away and back) ────────────
  const handleTabChange = (tab) => {
    updateParams({ tab })
    setShowFilter(false)
  }

  // The visible contract/notice number may contain whitespace or characters
  // that Excel/URLs normalize differently. Carrying the stable table row
  // index makes detail navigation reliable while retaining the readable URL.
  const openOpportunity = (opp) => {
    const cn = opp[C.contractNum] || ''
    navigate(`/opportunities/${encodeURIComponent(cn)}?row=${opp._rowIndex}`)
  }

  // ── CRUD handlers ─────────────────────────────────────────────────────
  const submitOpp = async ({ setSubmittedRfi = false } = {}) => {
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
    triggerPull,
    pullProgress,
  } = useSAMOpportunities()

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
  // Saves scrollTop before any render that could reset it, restores after.
  // useLayoutEffect runs after DOM mutations but before paint — invisible to user.
  const savedScrollTop = useRef(0)
  useLayoutEffect(() => {
    const el = tableScrollRef.current
    if (!el) return
    // Restore from the value saved before the last state update
    if (savedScrollTop.current > 0) {
      el.scrollTop = savedScrollTop.current
    }
  })

  // Call this before any state update that might re-render the table
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
    return true
  }).sort((a, b) => {
    // Default: earliest response date first
    const da = (a['Response Date'] || '').slice(0, 10)
    const db = (b['Response Date'] || '').slice(0, 10)
    if (!da && !db) return 0
    if (!da) return 1
    if (!db) return -1
    return da < db ? -1 : da > db ? 1 : 0
  }), [samOpps, showDismissed, deptFilter])

  const handleAddToPipeline = async (row, outlook) => {
    if (actioningRow === row._rowIndex) return
    setActioningRow(row._rowIndex)
    try {
      await addToPipeline(row, outlook)
      toast?.success(outlook === 'Tracking' ? 'Added to pipeline as Tracking' : 'Added to pipeline')
    } catch (err) {
      toast?.error(`Failed: ${err.message}`)
    } finally {
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
      toast?.error('Could not dismiss — will retry on next sync')
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
    if (failed > 0) toast?.error(`${failed} could not be dismissed — will retry on next sync`)
  }

  const handleUndismiss = async (row) => {
    if (actioningRow === row._rowIndex) return
    setActioningRow(row._rowIndex)
    try {
      await undismiss(row._rowIndex)
      toast?.success('Restored')
    } catch (err) {
      toast?.error(`Failed: ${err.message}`)
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
  const isPulling = pulling || pullProgress?.status === 'running'

  const pullProgressText = (() => {
    if (!pullProgress || pullProgress.status !== 'running') return null
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
    }
  }, [pullProgress])

  // Let the user know if a pull just started that THIS tab didn't initiate
  // (i.e. the auto-resume-a-stalled-run logic in the hook kicked in)
  const autoResumeNoticedRef = useRef(false)
  useEffect(() => {
    if (pullProgress?.status === 'running' && !pulling && !autoResumeNoticedRef.current) {
      autoResumeNoticedRef.current = true
      setPullMessage({ type: 'info', text: 'Resuming an opportunity pull that didn\u2019t finish in an earlier session…' })
    }
    if (pullProgress?.status === 'success' || pullProgress?.status === 'error') {
      autoResumeNoticedRef.current = false   // reset so a future stall can be noticed again
    }
  }, [pullProgress, pulling])

  const samStatusBadge = (status) => {
    if (status === 'added_to_pipeline') return <span className="badge badge-award"    style={{ fontSize: 10 }}>Added</span>
    if (status === 'tracked')           return <span className="badge badge-proposal" style={{ fontSize: 10 }}>Tracked</span>
    if (status === 'dismissed')         return <span className="badge badge-tracking" style={{ fontSize: 10, opacity: 0.6 }}>Dismissed</span>
    return null
  }

  const NewTab = () => (
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
                    {samRunStatus.written > 0 && <> · {samRunStatus.written} new</>}
                    {samRunStatus.deduped > 0 && <> · {samRunStatus.deduped} duplicate{samRunStatus.deduped === 1 ? '' : 's'} removed</>}
                    {samRunStatus.warnings?.length > 0 && (
                      <span style={{ color: 'var(--amber-600)' }} title={samRunStatus.warnings.join('\n')}>
                        {' '}· ⚠ {samRunStatus.warnings.length} warning{samRunStatus.warnings.length === 1 ? '' : 's'}
                      </span>
                    )}
                  </>
                )}
                {samRunStatus?.success === false && (
                  <span style={{ color: 'var(--red-600)' }} title={samRunStatus.warnings?.join('\n') || ''}>
                    Last run failed: {samRunStatus.error || 'Unknown error'}
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
                    ? 'Opportunities from SAM.gov matching your NAICS codes will appear here after the nightly pull.'
                    : 'All opportunities have been dismissed. Toggle "Show dismissed" to see them.'}
                </div>
              </div>
            )
            : (
              <div ref={tableScrollRef} style={{ overflowX: 'auto', overflowY: 'auto', maxHeight: 'calc(100vh - var(--topbar-height) - 100px)' }}>
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
                          ? <button style={{ fontSize: '10.5px', padding: '2px 8px', background: 'var(--red-600)', color: '#fff', border: 'none', borderRadius: 'var(--radius-md)', cursor: bulkDismissAction.isLoading ? 'default' : 'pointer', fontFamily: 'var(--font)', fontWeight: 500, opacity: bulkDismissAction.isLoading ? 0.7 : 1 }}
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
                                <button className="btn" style={btnSm}
                                  disabled={isActioning} onClick={() => handleUndismiss(opp)}>
                                  {isActioning ? '…' : 'Restore'}
                                </button>
                              )
                              : (
                                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4 }}>
                                  {!isActioned && (
                                    <>
                                      {/* Row 1: + Pipeline (blue) | Track (amber/white) */}
                                      <button className="btn btn-primary" style={btnSm}
                                        disabled={isActioning} onClick={() => handleAddToPipeline(opp, 'New')}>
                                        {isActioning ? '…' : '+ Pipeline'}
                                      </button>
                                      <button style={{ ...btnSm, background: 'var(--amber-600)', color: '#fff', border: 'none', borderRadius: 'var(--radius-md)', cursor: 'pointer', fontFamily: 'var(--font)', fontWeight: 500, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}
                                        disabled={isActioning} onClick={() => handleAddToPipeline(opp, 'Tracking')}>
                                        {isActioning ? '…' : 'Track'}
                                      </button>
                                      {/* Row 2: Dismiss (red/white) | SAM.gov (blue) */}
                                      <button style={{ ...btnSm, background: 'var(--red-600)', color: '#fff', border: 'none', borderRadius: 'var(--radius-md)', cursor: 'pointer', fontFamily: 'var(--font)', fontWeight: 500, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}
                                        disabled={isActioning} onClick={() => handleDismiss(opp)}>
                                        Dismiss
                                      </button>
                                    </>
                                  )}
                                  {opp['SAM.gov URL'] && (
                                    <a href={opp['SAM.gov URL']} target="_blank" rel="noreferrer"
                                      style={{ ...btnSm, background: 'var(--blue-600)', color: '#fff', border: 'none', borderRadius: 'var(--radius-md)', cursor: 'pointer', fontFamily: 'var(--font)', fontWeight: 500, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', textDecoration: 'none' }}>
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
              <td style={{ fontWeight: 500, maxWidth: 300 }}>{opp[C.title]}</td>
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
        subtitle1={`${activeTab !== 'New' ? filtered.length : 0} shown`}
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

        {/* ── Search bar (hidden on New tab) ── */}
        {activeTab !== 'New' && (
          <div className={styles.searchBar}>
            <span className={styles.searchIcon} aria-hidden="true">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
              </svg>
            </span>
            <input
              className={styles.searchInput}
              placeholder="Search by title, contract #, agency, NAICS, POC…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label="Search opportunities"
            />
            {search && (
              <button className={styles.searchClear} onClick={() => setSearch('')} aria-label="Clear search">✕</button>
            )}
          </div>
        )}

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
                  style={{ textAlign: 'left', cursor: 'pointer', background: '#fff' }}
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
        {activeTab === 'New' && <NewTab />}

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
          onClose={() => setShowAdd(false)}
          footer={
            <>
              <button className="btn" onClick={() => setShowAdd(false)}>Cancel</button>
              <button className="btn btn-primary" onClick={requestAdd} disabled={saving}>
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
