import { useState, useMemo } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { usePipeline } from '@/hooks/usePipeline'
import { useValidationLists, pickList } from '@/hooks/useValidationLists'
import Topbar from '@/components/Layout/Topbar'
import Modal from '@/components/Common/Modal'
import { formatDate } from '@/utils/kpiHelpers'
import { OPPORTUNITY_PHASES, OPPORTUNITY_OUTLOOK, SET_ASIDE_VALUES, PRIORITY_VALUES } from '@/services/graphService'
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
}

// ── Tab definitions ───────────────────────────────────────────────────────
const TABS = ['RFIs', 'Expiring', 'Tracked', 'New']

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

// ── Per-tab row filter (base filter before search/advanced filters) ────────
function getTabRows(pipeline, tab) {
  switch (tab) {
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
  RFIs:     { key: C.lastMod,  dir: 'desc' },
  Expiring: { key: C.endDate,  dir: 'asc'  },
  Tracked:  { key: C.lastMod,  dir: 'desc' },
  New:      { key: C.lastMod,  dir: 'desc' },
}

// ── Value formatter ───────────────────────────────────────────────────────
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
  const [searchParams] = useSearchParams()
  const { pipeline, loading, add, remove } = usePipeline()
  const { lists } = useValidationLists()

  const outlookOptions  = pickList(lists, 'Opportunity Outlook', OPPORTUNITY_OUTLOOK)
  const priorityOptions = pickList(lists, 'Priority', PRIORITY_VALUES)
  const setAsideOptions = pickList(lists, 'Set-Aside', SET_ASIDE_VALUES)
  const bidNoBidOptions = pickList(lists, 'Bid / No Bid?', ['Bid', 'No Bid', 'TBD'])
  const phaseOptions    = pickList(lists, 'TAG Opportunity Phase', OPPORTUNITY_PHASES)

  // ── Tab state — each tab carries its own sort so switching tabs restores
  //    the right default rather than sharing a single sort state
  const [activeTab, setActiveTab] = useState('RFIs')
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

  // ── Search + advanced filters ─────────────────────────────────────────
  const [search, setSearch] = useState('')
  const [showFilter, setShowFilter] = useState(false)
  const [filters, setFilters] = useState({
    outlook: '', priority: '', assignedTo: '', agency: '', setAside: '', bidNoBid: '',
  })
  const activeFilterCount = Object.values(filters).filter(Boolean).length

  // ── Modals ────────────────────────────────────────────────────────────
  const [showAdd, setShowAdd] = useState(searchParams.get('new') === '1')
  const [confirmDelete, setConfirmDelete] = useState(null)
  const [saving, setSaving] = useState(false)
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
    [C.priority]:    'Warm',
    [C.setAside]:    '-',
    [C.primeOrSub]:  'Prime',
  })

  // ── Tab counts (raw, before search/filters) ───────────────────────────
  const tabCounts = useMemo(() => ({
    RFIs:     getTabRows(pipeline, 'RFIs').length,
    Expiring: getTabRows(pipeline, 'Expiring').length,
    Tracked:  getTabRows(pipeline, 'Tracked').length,
    New:      0,
  }), [pipeline])

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
    if (filters.assignedTo) rows = rows.filter((o) =>
      String(o[C.assignedTo] || '').toLowerCase().includes(filters.assignedTo.toLowerCase())
    )
    if (filters.agency) rows = rows.filter((o) =>
      String(o[C.agency] || '').toLowerCase().includes(filters.agency.toLowerCase())
    )

    return [...rows].sort((a, b) => {
      const va = a[sortKey] ?? ''
      const vb = b[sortKey] ?? ''
      const cmp = va < vb ? -1 : va > vb ? 1 : 0
      return sortDir === 'asc' ? cmp : -cmp
    })
  }, [pipeline, activeTab, search, filters, sortKey, sortDir])

  // ── Tab switch — reset search + filters ──────────────────────────────
  const handleTabChange = (tab) => {
    setActiveTab(tab)
    setSearch('')
    setFilters({ outlook: '', priority: '', assignedTo: '', agency: '', setAside: '', bidNoBid: '' })
    setShowFilter(false)
  }

  // ── CRUD handlers ─────────────────────────────────────────────────────
  const submitOpp = async () => {
    setSaving(true)
    try {
      await add(form)
      toast?.success('Opportunity added')
      setShowAdd(false)
      setForm({
        [C.contractNum]: '', [C.title]: '', [C.agency]: '', [C.department]: '',
        [C.phase]: 'Identified', [C.outlook]: 'New', [C.value]: '',
        [C.assignedTo]: '', [C.solNum]: '', [C.naics]: '', [C.submDate]: '',
        [C.priority]: 'Warm', [C.setAside]: '-', [C.primeOrSub]: 'Prime',
      })
    } catch (err) {
      toast?.error(`Failed to add: ${err.message}`)
    } finally {
      setSaving(false)
    }
  }

  const handleAdd = (e) => { e.preventDefault(); submitOpp() }

  const handleDelete = async () => {
    if (!confirmDelete) return
    try {
      await remove(confirmDelete._rowIndex)
      toast?.success('Opportunity deleted')
    } catch (err) {
      toast?.error(`Failed to delete: ${err.message}`)
    } finally {
      setConfirmDelete(null)
    }
  }

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
          RFIs:     'No RFIs found. RFIs are opportunities with Phase = Identified and Outlook = New.',
          Expiring: 'No expiring opportunities. Set an opportunity\'s Outlook to "Expiring" to see it here.',
          Tracked:  'No tracked opportunities. Set an opportunity\'s Outlook to "Tracking" to see it here.',
          New:      '',
        }[activeTab]

  // ── Table renderers (one per tab) ─────────────────────────────────────

  const RFIsTable = () => (
    <table className="data-table">
      <thead>
        <tr>
          <th onClick={() => handleSort(C.title)} style={{ cursor: 'pointer' }}>Title <SortIcon col={C.title} /></th>
          <th>Contract #</th>
          <th onClick={() => handleSort(C.agency)} style={{ cursor: 'pointer' }}>Agency <SortIcon col={C.agency} /></th>
          <th onClick={() => handleSort(C.lastMod)} style={{ cursor: 'pointer' }}>Last modified <SortIcon col={C.lastMod} /></th>
        </tr>
      </thead>
      <tbody>
        {filtered.map((opp) => {
          const cn = opp[C.contractNum]
          return (
            <tr key={`${cn}-${opp._rowIndex}`}
              onClick={() => navigate(`/opportunities/${encodeURIComponent(cn)}`)}>
              <td style={{ fontWeight: 500, maxWidth: 300 }}>{opp[C.title]}</td>
              <td className="text-xs text-muted" style={{ whiteSpace: 'nowrap' }}>{cn}</td>
              <td className="text-sm text-muted">{opp[C.agency] || '—'}</td>
              <td className="text-sm text-muted">{formatDate(opp[C.lastMod])}</td>
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
              onClick={() => navigate(`/opportunities/${encodeURIComponent(cn)}`)}>
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
              onClick={() => navigate(`/opportunities/${encodeURIComponent(cn)}`)}>
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
              <div className="form-field">
                <label className="form-label">Agency</label>
                <input className="form-input" placeholder="Filter by agency…"
                  value={filters.agency}
                  onChange={(e) => setFilters((f) => ({ ...f, agency: e.target.value }))} />
              </div>
              <div className="form-field">
                <label className="form-label">Assigned To</label>
                <input className="form-input" placeholder="Filter by assignee…"
                  value={filters.assignedTo}
                  onChange={(e) => setFilters((f) => ({ ...f, assignedTo: e.target.value }))} />
              </div>
            </div>
            {activeFilterCount > 0 && (
              <button className="btn btn-ghost text-sm"
                style={{ marginTop: 8, color: 'var(--red-600)' }}
                onClick={() => setFilters({ outlook: '', priority: '', assignedTo: '', agency: '', setAside: '', bidNoBid: '' })}>
                Clear all filters ({activeFilterCount})
              </button>
            )}
          </div>
        )}

        {/* Active filter chips */}
        {activeFilterCount > 0 && activeTab !== 'New' && (
          <div className="filter-chips" style={{ marginBottom: 8 }}>
            {Object.entries(filters).filter(([, v]) => v).map(([key, val]) => (
              <button key={key}
                className="filter-chip active"
                onClick={() => setFilters((f) => ({ ...f, [key]: '' }))}>
                {val} ✕
              </button>
            ))}
          </div>
        )}

        {/* ── Table card ── */}
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>

          {/* New tab — coming soon placeholder */}
          {activeTab === 'New' && (
            <div className={styles.empty} style={{ padding: '48px 24px' }}>
              <div style={{ fontSize: 28, marginBottom: 8, opacity: 0.3 }}>◈</div>
              <div style={{ fontWeight: 600, fontSize: 14, color: 'var(--gray-900)', marginBottom: 4 }}>
                New opportunities coming soon
              </div>
              <div style={{ fontSize: 13, color: 'var(--gray-400)', maxWidth: 360, textAlign: 'center' }}>
                This tab will surface opportunities pulled from SAM.gov that match your NAICS and set-aside profile.
              </div>
            </div>
          )}

          {/* All other tabs */}
          {activeTab !== 'New' && (
            loading
              ? <div style={{ padding: 20 }}><div className="skeleton" style={{ height: 200 }} /></div>
              : filtered.length === 0
                ? <div className={styles.empty}>{emptyMsg}</div>
                : (
                  <div style={{ overflowX: 'auto' }}>
                    {activeTab === 'RFIs'     && <RFIsTable />}
                    {activeTab === 'Expiring' && <ExpiringTable />}
                    {activeTab === 'Tracked'  && <TrackedTable />}
                  </div>
                )
          )}
        </div>
      </div>

      {/* ── New opportunity modal ── */}
      {showAdd && (
        <Modal
          title="New opportunity"
          onClose={() => setShowAdd(false)}
          footer={
            <>
              <button className="btn" onClick={() => setShowAdd(false)}>Cancel</button>
              <button className="btn btn-primary" onClick={submitOpp} disabled={saving}>
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
                <input className="form-input"
                  value={form[C.assignedTo]}
                  onChange={(e) => setForm({ ...form, [C.assignedTo]: e.target.value })} />
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
              <div className="form-field">
                <label className="form-label">RFI Submission Date</label>
                <input className="form-input" type="date"
                  value={form[C.submDate]}
                  onChange={(e) => setForm({ ...form, [C.submDate]: e.target.value })} />
              </div>
            </div>
          </form>
        </Modal>
      )}

      {/* ── Delete confirmation modal ── */}
      {confirmDelete && (
        <Modal
          title="Delete opportunity"
          onClose={() => setConfirmDelete(null)}
          footer={
            <>
              <button className="btn" onClick={() => setConfirmDelete(null)}>Cancel</button>
              <button className="btn btn-danger" onClick={handleDelete}>Delete</button>
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
