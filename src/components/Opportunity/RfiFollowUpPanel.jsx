import { useEffect, useState } from 'react'
import { effectiveRfiFollowUpCriteria } from '@/hooks/useRfiFollowUpMonitor'
import { formatDate } from '@/utils/kpiHelpers'
import { useSaveShortcut } from '@/shortcuts/SaveShortcutContext'

function safeUrl(url) {
  try { const parsed = new URL(url); return ['http:', 'https:'].includes(parsed.protocol) ? parsed.href : '' } catch { return '' }
}

export default function RfiFollowUpPanel({ opp, contacts, linkedContractNumbers, monitor, onAddToPipeline, onSaveDecision, onSaveOverride, focusRequested, panelRef, toast, columns }) {
  const opportunityId = opp?.[columns.contractNum] || ''
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
  useSaveShortcut({
    enabled: editingCriteria && Boolean(criteria) && !savingCriteria,
    label: 'these RFI follow-up criteria',
    onSave: saveCriteria,
    scopeRef: panelRef,
  })

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
