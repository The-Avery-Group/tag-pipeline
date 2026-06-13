import { useState, useMemo } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { usePipeline } from '@/hooks/usePipeline'
import { useValidationLists, pickList } from '@/hooks/useValidationLists'
import Topbar from '@/components/Layout/Topbar'
import Modal from '@/components/Common/Modal'
import { formatDate, isOverdue } from '@/utils/kpiHelpers'
import { OPPORTUNITY_PHASES, OPPORTUNITY_OUTLOOK, SET_ASIDE_VALUES, PRIORITY_VALUES } from '@/services/graphService'
import styles from './Opportunities.module.css'

// Real column names
const C = {
  phase:       'TAG Opportunity Phase',
  activityPhase:'TAG Pipeline Activity Phase',
  contractNum: 'Contract Number / Notice ID',
  title:       'Project Title / Description*',
  agency:      'Agency*',
  department:  'Department*',
  value:       'Total Contract Value ($)*',
  assignedTo:  'Assigned To*',
  lastMod:     'Last Modified*',
  submDate:    'Submission Date (Response Date)*',
  solNum:      'Solicitation Number',
  naics:       'NAICS Code*',
  outlook:     'Opportunity Outlook',
  priority:    'Priority',
  setAside:    'Set- Aside*',
  poc:         'Contracting Officer / Specialist (POC)*',
  endDate:     'Contract End Date*',
  bidNoBid:    'Bid / No Bid?',
  partner:     'Partner',
  primeOrSub:  'Prime or Sub?',
  notes:       'Notes*',
  awardDate:   'Anticipated year for Award (MM/DD/YYYY)*',
  folder:      'Link to Folder',
  govwin:      'GovWin Link*',
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

export default function Opportunities({ toast }) {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const { pipeline, loading, add, remove } = usePipeline()
  const { lists } = useValidationLists()

  const phaseOptions   = pickList(lists, 'TAG Opportunity Phase', OPPORTUNITY_PHASES)
  const outlookOptions = pickList(lists, 'Opportunity Outlook', OPPORTUNITY_OUTLOOK)
  const priorityOptions = pickList(lists, 'Priority', PRIORITY_VALUES)
  const setAsideOptions = pickList(lists, 'Set-Aside', SET_ASIDE_VALUES)
  const PHASES = ['All', ...phaseOptions]

  const [phase, setPhase] = useState('All')
  const [sortKey, setSortKey] = useState(C.lastMod)
  const [sortDir, setSortDir] = useState('desc')
  const [showAdd, setShowAdd] = useState(searchParams.get('new') === '1')
  const [confirmDelete, setConfirmDelete] = useState(null)
  const [saving, setSaving] = useState(false)
  const [form, setForm] = useState({
    [C.contractNum]: '',
    [C.title]: '',
    [C.agency]: '',
    [C.department]: '',
    [C.phase]: 'Research',
    [C.outlook]: 'Forecasted',
    [C.value]: '',
    [C.assignedTo]: '',
    [C.solNum]: '',
    [C.naics]: '',
    [C.submDate]: '',
    [C.priority]: 'Warm',
    [C.setAside]: '-',
    [C.primeOrSub]: 'Prime',
  })

  const filtered = useMemo(() => {
    let rows = phase === 'All' ? pipeline : pipeline.filter((o) => o[C.phase] === phase)
    return [...rows].sort((a, b) => {
      const va = a[sortKey] ?? ''
      const vb = b[sortKey] ?? ''
      const cmp = va < vb ? -1 : va > vb ? 1 : 0
      return sortDir === 'asc' ? cmp : -cmp
    })
  }, [pipeline, phase, sortKey, sortDir])

  const handleSort = (key) => {
    if (sortKey === key) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    else { setSortKey(key); setSortDir('asc') }
  }

  const submitOpp = async () => {
    setSaving(true)
    try {
      await add(form)
      toast?.success('Opportunity added')
      setShowAdd(false)
      setForm({
        [C.contractNum]: '', [C.title]: '', [C.agency]: '', [C.department]: '',
        [C.phase]: 'Research', [C.outlook]: 'Forecasted', [C.value]: '',
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

  const SortIcon = ({ col }) => (
    <span className={styles.sortIcon} aria-hidden="true">
      {sortKey === col ? (sortDir === 'asc' ? '↑' : '↓') : '↕'}
    </span>
  )

  const fmtValue = (v) => {
    const n = parseFloat(String(v ?? '').replace(/[^0-9.]/g, ''))
    if (!n) return '—'
    if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`
    if (n >= 1_000) return `$${(n / 1_000).toFixed(0)}K`
    return `$${n.toFixed(0)}`
  }

  return (
    <>
      <Topbar
        title="Opportunities"
        subtitle1={`${filtered.length} shown`}
        showFilter={true}
        showNew={true}
        newLabel="New opportunity"
        onNew={() => setShowAdd(true)}
      />
      <div className="page-body">
        <div className="filter-chips" style={{ marginBottom: 14 }}>
          {PHASES.map((p) => (
            <button key={p} className={`filter-chip ${phase === p ? 'active' : ''}`} onClick={() => setPhase(p)}>
              {p}
            </button>
          ))}
        </div>

        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          {loading
            ? <div style={{ padding: 20 }}><div className="skeleton" style={{ height: 200 }} /></div>
            : filtered.length === 0
              ? <div className={styles.empty}>No opportunities match the current filter.</div>
              : (
                <div style={{ overflowX: 'auto' }}>
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th onClick={() => handleSort(C.title)} style={{ cursor: 'pointer' }}>Title <SortIcon col={C.title} /></th>
                        <th>Contract #</th>
                        <th onClick={() => handleSort(C.phase)} style={{ cursor: 'pointer' }}>Phase <SortIcon col={C.phase} /></th>
                        <th>Outlook</th>
                        <th onClick={() => handleSort(C.value)} style={{ cursor: 'pointer' }}>Value <SortIcon col={C.value} /></th>
                        <th>Assigned To</th>
                        <th>Priority</th>
                        <th onClick={() => handleSort(C.submDate)} style={{ cursor: 'pointer' }}>Due <SortIcon col={C.submDate} /></th>
                        <th onClick={() => handleSort(C.lastMod)} style={{ cursor: 'pointer' }}>Last modified <SortIcon col={C.lastMod} /></th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {filtered.map((opp) => {
                        const cn = opp[C.contractNum]
                        const due = opp[C.submDate]
                        const priority = opp[C.priority]
                        return (
                          <tr key={`${cn}-${opp._rowIndex}`} onClick={() => navigate(`/opportunities/${encodeURIComponent(cn)}`)}>
                            <td style={{ fontWeight: 500, maxWidth: 260 }}>{opp[C.title]}</td>
                            <td className="text-xs text-muted" style={{ whiteSpace: 'nowrap' }}>{cn}</td>
                            <td>
                              <span className={`badge ${PHASE_BADGE[opp[C.phase]] || 'badge-tracking'}`}>
                                {opp[C.phase]}
                              </span>
                            </td>
                            <td className="text-sm text-muted">{opp[C.outlook]}</td>
                            <td className="text-sm">{fmtValue(opp[C.value])}</td>
                            <td className="text-sm">{opp[C.assignedTo]}</td>
                            <td>
                              {priority && (
                                <span className={`badge ${priority === 'Hot' ? 'badge-high' : priority === 'Warm' ? 'badge-medium' : 'badge-low'}`}>
                                  {priority}
                                </span>
                              )}
                            </td>
                            <td className={`text-sm ${isOverdue(due) ? 'text-danger' : 'text-muted'}`}>{formatDate(due)}</td>
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
                </div>
              )}
        </div>
      </div>

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
                <input className="form-input" required value={form[C.title]} onChange={(e) => setForm({ ...form, [C.title]: e.target.value })} />
              </div>
              <div className="form-field">
                <label className="form-label">Contract Number / Notice ID *</label>
                <input className="form-input" required value={form[C.contractNum]} onChange={(e) => setForm({ ...form, [C.contractNum]: e.target.value })} />
              </div>
              <div className="form-field">
                <label className="form-label">Solicitation Number</label>
                <input className="form-input" value={form[C.solNum]} onChange={(e) => setForm({ ...form, [C.solNum]: e.target.value })} />
              </div>
              <div className="form-field">
                <label className="form-label">Department</label>
                <input className="form-input" value={form[C.department]} onChange={(e) => setForm({ ...form, [C.department]: e.target.value })} />
              </div>
              <div className="form-field">
                <label className="form-label">Agency</label>
                <input className="form-input" value={form[C.agency]} onChange={(e) => setForm({ ...form, [C.agency]: e.target.value })} />
              </div>
              <div className="form-field">
                <label className="form-label">TAG Opportunity Phase</label>
                <select className="form-input" value={form[C.phase]} onChange={(e) => setForm({ ...form, [C.phase]: e.target.value })}>
                  {phaseOptions.map((p) => <option key={p}>{p}</option>)}
                </select>
              </div>
              <div className="form-field">
                <label className="form-label">Opportunity Outlook</label>
                <select className="form-input" value={form[C.outlook]} onChange={(e) => setForm({ ...form, [C.outlook]: e.target.value })}>
                  {outlookOptions.map((o) => <option key={o}>{o}</option>)}
                </select>
              </div>
              <div className="form-field">
                <label className="form-label">Total Contract Value ($)</label>
                <input className="form-input" type="number" value={form[C.value]} onChange={(e) => setForm({ ...form, [C.value]: e.target.value })} />
              </div>
              <div className="form-field">
                <label className="form-label">NAICS Code</label>
                <input className="form-input" value={form[C.naics]} onChange={(e) => setForm({ ...form, [C.naics]: e.target.value })} />
              </div>
              <div className="form-field">
                <label className="form-label">Assigned To</label>
                <input className="form-input" value={form[C.assignedTo]} onChange={(e) => setForm({ ...form, [C.assignedTo]: e.target.value })} />
              </div>
              <div className="form-field">
                <label className="form-label">Priority</label>
                <select className="form-input" value={form[C.priority]} onChange={(e) => setForm({ ...form, [C.priority]: e.target.value })}>
                  {priorityOptions.map((p) => <option key={p}>{p}</option>)}
                </select>
              </div>
              <div className="form-field">
                <label className="form-label">Set-Aside</label>
                <select className="form-input" value={form[C.setAside]} onChange={(e) => setForm({ ...form, [C.setAside]: e.target.value })}>
                  {setAsideOptions.map((s) => <option key={s}>{s}</option>)}
                </select>
              </div>
              <div className="form-field">
                <label className="form-label">Submission / Response Date</label>
                <input className="form-input" type="date" value={form[C.submDate]} onChange={(e) => setForm({ ...form, [C.submDate]: e.target.value })} />
              </div>
            </div>
          </form>
        </Modal>
      )}

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
