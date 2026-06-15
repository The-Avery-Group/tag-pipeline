import { useState, useMemo, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { usePipeline } from '@/hooks/usePipeline'
import { useValidationLists, pickList } from '@/hooks/useValidationLists'
import Topbar from '@/components/Layout/Topbar'
import { formatCurrency } from '@/utils/kpiHelpers'
import { OPPORTUNITY_PHASES } from '@/services/graphService'
import styles from './PipelineBoard.module.css'

const C = {
  phase:        'TAG Opportunity Phase',
  actPhase:     'TAG Pipeline Activity Phase',
  title:        'Project Title / Description*',
  contractNum:  'Contract Number / Notice ID',
  agency:       'Agency*',
  value:        'Total Contract Value ($)*',
  outlook:      'Opportunity Outlook',
  assignedTo:   'Assigned To*',
}

const PHASE_COLORS = {
  'Identified':       '#C7D9F5',
  'Research':         '#FAC775',
  'Qualified':        '#F59B42',
  'Proposal':         '#85B7EB',
  'Pending Award':    '#B39DDB',
  'Contract Awarded': '#9FE1CB',
  'Cancelled':        '#E0E0E0',
}

function parseValue(v) {
  const n = parseFloat(String(v || '0').replace(/[^0-9.]/g, ''))
  return isNaN(n) ? 0 : n
}

export default function PipelineBoard({ toast }) {
  const navigate = useNavigate()
  const { pipeline, loading, update } = usePipeline()
  const { lists } = useValidationLists()
  const phases = pickList(lists, 'TAG Opportunity Phase', OPPORTUNITY_PHASES)
  const activityPhases = pickList(lists, 'TAG Pipeline Activity Phase', [
    'Pre-RFP', 'Submitted RFI', 'RFP Released', 'Proposal Submitted',
    'BAFO', 'Award Pending',
  ])

  // Which sections are expanded — all collapsed by default
  const [expanded, setExpanded] = useState({})
  // Track which opportunity is currently being moved: { [contractNum]: true }
  const [moving, setMoving] = useState({})
  const [movingActivity, setMovingActivity] = useState({})

  const toggleSection = useCallback((phase) => {
    setExpanded((prev) => ({ ...prev, [phase]: !prev[phase] }))
  }, [])

  // Group opportunities by phase
  const grouped = useMemo(() => {
    const map = {}
    phases.forEach((p) => { map[p] = [] })
    pipeline.forEach((opp) => {
      const p = opp[C.phase]
      if (p && map[p]) map[p].push(opp)
      else if (p) map[p] = [opp]    // unknown phase — still show it
    })
    return map
  }, [pipeline, phases])

  // Phase totals
  const totals = useMemo(() => {
    const t = {}
    Object.entries(grouped).forEach(([phase, opps]) => {
      t[phase] = {
        count: opps.length,
        value: opps.reduce((sum, o) => sum + parseValue(o[C.value]), 0),
      }
    })
    return t
  }, [grouped])

  const handleActivityMove = useCallback(async (opp, newActivity, e) => {
    e.stopPropagation()
    const cn = opp[C.contractNum]
    if (movingActivity[cn]) return
    if (newActivity === opp[C.actPhase]) return
    setMovingActivity((prev) => ({ ...prev, [cn]: true }))
    try {
      await update(opp._rowIndex, { [C.actPhase]: newActivity }, opp)
      toast?.success(`Activity phase updated`)
    } catch (err) {
      toast?.error(`Failed to update: ${err.message}`)
    } finally {
      setMovingActivity((prev) => { const n = { ...prev }; delete n[cn]; return n })
    }
  }, [movingActivity, update, toast])

  const handleMove = useCallback(async (opp, newPhase, e) => {
    e.stopPropagation()
    const cn = opp[C.contractNum]
    if (moving[cn]) return                    // already in flight — ignore
    if (newPhase === opp[C.phase]) return     // same phase — no-op

    setMoving((prev) => ({ ...prev, [cn]: true }))

    // Optimistic update — move immediately in local state
    // usePipeline will reconcile after the write completes
    try {
      await update(opp._rowIndex, { [C.phase]: newPhase }, opp)
      toast?.success(`Moved to ${newPhase}`)
    } catch (err) {
      toast?.error(`Failed to move: ${err.message}`)
    } finally {
      setMoving((prev) => { const n = { ...prev }; delete n[cn]; return n })
    }
  }, [moving, update, toast])

  return (
    <>
      <Topbar
        title="Pipeline Board"
        subtitle1={`${pipeline.length} opportunities`}
        showFilter={false}
        showNew={false}
      />
      <div className="page-body">
        {loading && pipeline.length === 0
          ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {[1, 2, 3].map((i) => (
                <div key={i} className="skeleton" style={{ height: 52, borderRadius: 8 }} />
              ))}
            </div>
          )
          : phases.map((phase) => {
              const isOpen = !!expanded[phase]
              const opps   = grouped[phase] || []
              const total  = totals[phase]  || { count: 0, value: 0 }
              const color  = PHASE_COLORS[phase] || 'var(--gray-200)'

              return (
                <div key={phase} className={styles.section}>
                  {/* Section header — always visible */}
                  <button
                    className={styles.sectionHeader}
                    onClick={() => toggleSection(phase)}
                    aria-expanded={isOpen}
                  >
                    <span
                      className={styles.sectionColor}
                      style={{ background: color }}
                    />
                    <span className={styles.sectionName}>{phase}</span>
                    <span className={styles.sectionMeta}>
                      <span className={styles.sectionCount}>{total.count}</span>
                      {total.value > 0 && (
                        <span className={styles.sectionValue}>
                          {formatCurrency(total.value)}
                        </span>
                      )}
                    </span>
                    <span className={`${styles.chevron} ${isOpen ? styles.chevronOpen : ''}`}>
                      ›
                    </span>
                  </button>

                  {/* Expanded table */}
                  {isOpen && (
                    <div className={styles.sectionBody}>
                      {opps.length === 0
                        ? (
                          <div className={styles.emptySection}>
                            No opportunities in this phase.
                          </div>
                        )
                        : (
                          <>
                            {/* Table header */}
                            <div className={`${styles.row} ${styles.rowHeader}`}>
                              <span className={styles.colTitle}>Opportunity</span>
                              <span className={styles.colAgency}>Agency</span>
                              <span className={styles.colValue}>Value</span>
                              <span className={styles.colActivity}>Activity phase</span>
                              <span className={styles.colMove}>Move to phase</span>
                            </div>
                            {/* Opportunity rows */}
                            {opps.map((opp) => {
                              const cn        = opp[C.contractNum]
                              const isMoving  = !!moving[cn]
                              const val       = parseValue(opp[C.value])

                              return (
                                <div
                                  key={cn}
                                  className={`${styles.row} ${isMoving ? styles.rowMoving : ''}`}
                                  onClick={() => !isMoving && navigate(`/opportunities/${encodeURIComponent(cn)}`)}
                                >
                                  <span className={styles.colTitle}>
                                    {opp[C.title]}
                                  </span>
                                  <span className={styles.colAgency}>
                                    {opp[C.agency] || '—'}
                                  </span>
                                  <span className={styles.colValue}>
                                    {val ? formatCurrency(val) : '—'}
                                  </span>
                                  <span className={styles.colActivity} onClick={(e) => e.stopPropagation()}>
                                    {movingActivity[cn]
                                      ? (
                                        <span className={styles.movingDots}>
                                          {[0, 1, 2].map((i) => (
                                            <span key={i} className={styles.movingDot}
                                              style={{ animationDelay: `${i * 0.2}s` }} />
                                          ))}
                                        </span>
                                      )
                                      : (
                                        <select
                                          className={styles.moveSelect}
                                          value={opp[C.actPhase] || ''}
                                          onChange={(e) => handleActivityMove(opp, e.target.value, e)}
                                          disabled={isMoving || !!movingActivity[cn]}
                                        >
                                          <option value="">— Select —</option>
                                          {activityPhases.map((p) => (
                                            <option key={p} value={p}>{p}</option>
                                          ))}
                                        </select>
                                      )
                                    }
                                  </span>
                                  <span className={styles.colMove} onClick={(e) => e.stopPropagation()}>
                                    {isMoving
                                      ? (
                                        <span className={styles.movingDots}>
                                          {[0, 1, 2].map((i) => (
                                            <span key={i} className={styles.movingDot}
                                              style={{ animationDelay: `${i * 0.2}s` }} />
                                          ))}
                                        </span>
                                      )
                                      : (
                                        <select
                                          className={styles.moveSelect}
                                          value={opp[C.phase]}
                                          onChange={(e) => handleMove(opp, e.target.value, e)}
                                          disabled={isMoving}
                                        >
                                          {phases.map((p) => (
                                            <option key={p} value={p}>{p}</option>
                                          ))}
                                        </select>
                                      )
                                    }
                                  </span>
                                </div>
                              )
                            })}
                          </>
                        )
                      }
                    </div>
                  )}
                </div>
              )
            })
        }
      </div>
    </>
  )
}
