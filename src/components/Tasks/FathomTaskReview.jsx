import { useCallback, useEffect, useRef, useState } from 'react'
import Modal from '@/components/Common/Modal'
import AutoTextarea from '@/components/Common/AutoTextarea'
import { workerJson, startAdaptivePolling, WORKER_URL } from '@/services/workerClient'
import { getNotificationRecipients } from '@/services/graphService'
import { invalidateCache } from '@/services/dataCache'
import { notifyTaskCreated } from '@/services/notifyService'

const empty = { enabled: false, proposals: [], jobs: [] }
const fieldStyle = { display: 'grid', gap: 6, width: '100%' }
const inputStyle = { width: '100%', minWidth: 0 }

export default function FathomTaskReview({ pipeline, onCount, toast }) {
  const [data, setData] = useState(empty)
  const [error, setError] = useState('')
  const [selected, setSelected] = useState(null)
  const [form, setForm] = useState(null)
  const [recipients, setRecipients] = useState([])
  const [busy, setBusy] = useState(false)
  const [editorError, setEditorError] = useState('')
  const editorId = useRef(null)
  const receive = useCallback(result => {
    setData(result)
    setError('')
    onCount(result.proposals?.length || 0)
  }, [onCount])
  const refresh = useCallback(async () => {
    if (!WORKER_URL) return
    try { receive(await workerJson('/fathom/review')) }
    catch (e) { setError(e.message) }
  }, [receive])

  useEffect(() => {
    if (!WORKER_URL) return undefined
    // One shared, backed-off poll. Stops when hidden/offline and when disabled.
    return startAdaptivePolling({ key: 'fathom-review', poll: async () => {
      try { return await workerJson('/fathom/review') }
      catch (e) { setError(e.message); throw e }
    }, onResult: receive, shouldContinue: result => result.enabled !== false })
  }, [receive])

  // Expire visible proposals even if the next poll is delayed or offline.
  useEffect(() => {
    const expiries = [...(data.proposals || []), ...(data.jobs || [])].map(p => Date.parse(p.expiresAt)).filter(Number.isFinite)
    if (!expiries.length) return undefined
    const timer = window.setTimeout(() => {
      const active = p => Date.parse(p.expiresAt) > Date.now()
      const proposals = data.proposals.filter(active)
      setData(current => ({ ...current, proposals, jobs: current.jobs.filter(active) }))
      onCount(proposals.length)
      if (selected && !active(selected)) { setSelected(null); setForm(null) }
    }, Math.max(0, Math.min(...expiries) - Date.now()) + 50)
    return () => window.clearTimeout(timer)
  }, [data, onCount, selected])

  const open = async proposal => {
    editorId.current = proposal.id
    setEditorError('')
    setSelected(proposal)
    setForm({ title: proposal.title, description: proposal.description || '', opportunityId: '', assignee: '', dueDate: proposal.dueDate || '', includeMeetingLink: Boolean(proposal.meetingReference) })
    try {
      const users = await getNotificationRecipients()
      if (editorId.current !== proposal.id) return
      setRecipients(users)
      const email = proposal.suggestedAssignee?.email?.toLowerCase()
      const matches = email ? users.filter(u => String(u['Teams UPN / Entra Object ID'] || '').trim().toLowerCase() === email) : []
      // Only a unique exact email match can preselect an actual CRM user.
      if (matches.length === 1) setForm(current => current && ({ ...current, assignee: matches[0]['Pipeline Assignee'] }))
    } catch { if (editorId.current === proposal.id) setEditorError('The notification user list could not load. Close and try again.') }
  }
  const act = async (proposal, action, body) => {
    setBusy(true)
    setEditorError('')
    try {
      const result = await workerJson(`/fathom/proposals/${proposal.id}/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) })
      if (action === 'approve' && !result.approved) throw new Error('The integration is not enabled. No task was created.')
      if (action === 'approve') {
        if (!result.alreadyExisted && result.task) notifyTaskCreated(result.task).catch(() => {})
        await invalidateCache(['TasksTable'])
        toast?.success('Task added to the pipeline')
      }
      setSelected(null)
      setForm(null)
      await refresh()
    } catch (e) { setEditorError(e.message); await refresh() }
    finally { setBusy(false) }
  }
  if (!data.enabled && !error) return null
  const opportunities = pipeline.filter(p => !['yes','true','1'].includes(String(p.Archived || '').toLowerCase()))
  const names = [...new Set(recipients.map(r => r['Pipeline Assignee']).filter(Boolean))].sort()
  return <section aria-label="Meeting task proposals" style={{ marginTop: 16 }}>
    <h3 className="text-sm" style={{ marginBottom: 8 }}>TAG Capture task proposals</h3>
    <p className="text-sm text-muted">Review and edit before adding a task. Unapproved proposals expire 48 hours after the meeting ends.</p>
    {error && <p role="alert" className="text-sm">{error} <button className="btn btn-sm" onClick={refresh}>Try again</button></p>}
    {data.recoveryIssue && <p role="status" className="text-sm">{data.recoveryIssue}</p>}
    {data.jobs?.map(job => <div key={job.id} className="text-sm" style={{ marginTop: 10 }}>
      <span>TAG Capture, {new Date(job.ended).toLocaleDateString()}: {job.status === 'attention' ? 'Processing needs attention.' : 'Processing meeting tasks…'}</span>
      {job.status === 'attention' && <button className="btn btn-sm" disabled={busy} style={{ marginLeft: 8 }} onClick={async () => {
        setBusy(true)
        try { await workerJson(`/fathom/jobs/${job.id}/retry`, { method: 'POST' }); await refresh() }
        catch (e) { setError(e.message) }
        finally { setBusy(false) }
      }}>Retry processing</button>}
    </div>)}
    {!data.jobs?.length && !data.proposals?.length && <p className="text-sm text-muted">No meeting tasks waiting for review.</p>}
    {data.proposals?.map(proposal => <div key={proposal.id} style={{ display: 'flex', gap: 12, alignItems: 'center', justifyContent: 'space-between', padding: '12px 0', borderBottom: '1px solid var(--gray-200)' }}>
      <div style={{ minWidth: 0 }}>
        <div className="text-sm">{proposal.title}</div>
        <div className="text-sm text-muted">TAG Capture, {new Date(proposal.ended).toLocaleDateString()}{proposal.suggestedAssignee?.name ? ` · Suggested: ${proposal.suggestedAssignee.name}` : ''}</div>
      </div>
      <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => open(proposal)}>Review task</button>
    </div>)}
    {selected && form && <Modal title="Review meeting task" onClose={() => { setSelected(null); setForm(null) }} dismissible={!busy} footer={<>
      <button className="btn btn-danger" disabled={busy || selected.status === 'approving'} onClick={() => act(selected, 'reject')}>Reject</button>
      <button className="btn" disabled={busy} onClick={() => { setSelected(null); setForm(null) }}>Cancel</button>
      <button className="btn btn-primary" disabled={busy || (selected.status !== 'approving' && (!form.title.trim() || !form.opportunityId || !form.assignee || !form.dueDate))} onClick={() => act(selected, 'approve', form)}>{busy ? 'Saving…' : selected.status === 'approving' ? 'Check previous save' : 'Approve task'}</button>
    </>}>
      <div style={{ display: 'grid', gap: 16 }}>
        {editorError && <p role="alert" className="text-sm">{editorError}</p>}
        {selected.needsReview && <p className="text-sm text-muted">The discussion was unclear. Confirm that this task is needed before approving.</p>}
        <label style={fieldStyle}>Task title<AutoTextarea className="form-input" style={inputStyle} rows={2} maxLength={250} value={form.title} onChange={e => setForm({ ...form, title: e.target.value })} /></label>
        <label style={fieldStyle}>Description<AutoTextarea className="form-input" style={inputStyle} rows={3} maxLength={5000} value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} /></label>
        <label style={fieldStyle}>Opportunity<select className="form-input" style={inputStyle} value={form.opportunityId} onChange={e => setForm({ ...form, opportunityId: e.target.value })}>
          <option value="">Choose a pipeline opportunity</option>
          {opportunities.map(p => <option key={p['Opportunity ID'] || p['Contract Number / Notice ID']} value={p['Opportunity ID'] || p['Contract Number / Notice ID']}>{p['Project Title / Description*']} ({p['Contract Number / Notice ID']})</option>)}
        </select></label>
        <label style={fieldStyle}>Assignee<select className="form-input" style={inputStyle} value={form.assignee} onChange={e => setForm({ ...form, assignee: e.target.value })}>
          <option value="">Choose a user</option>{names.map(name => <option key={name}>{name}</option>)}
        </select></label>
        {!names.length && <p className="text-sm text-muted">Configure the notification recipient list before approving tasks.</p>}
        <label style={fieldStyle}>Due date<input className="form-input" style={inputStyle} type="date" value={form.dueDate} onChange={e => setForm({ ...form, dueDate: e.target.value })} /></label>
        {selected.deadlineNeedsReview && <p className="text-sm text-muted">Confirm the deadline mentioned in the meeting.</p>}
        {selected.meetingReference && <div>
          <label><input type="checkbox" checked={form.includeMeetingLink} onChange={e => setForm({ ...form, includeMeetingLink: e.target.checked })} /> Include meeting link in the task</label>
          <div style={{ marginTop: 8 }}><a className="btn btn-sm" href={selected.meetingReference.url} target="_blank" rel="noopener noreferrer">View meeting</a></div>
        </div>}
      </div>
    </Modal>}
  </section>
}
