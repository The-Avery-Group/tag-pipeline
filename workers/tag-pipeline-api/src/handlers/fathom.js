import { advanceAnalysis, extractModelOutput } from '../lib/fathomAnalysis.js'
import { readWorkbookTable, graphWorkbookFetch } from '../lib/graph.js'

export const FATHOM_CRON = '2,7,12,17,22,27,32,37,42,47,52,57 * * * *'
export const FATHOM_MODEL = '@cf/openai/gpt-oss-120b'
const HOURS_48 = 48 * 60 * 60 * 1000
const DRIVE = 'b!DvVPmhUD7k2Va33gQGDdB3rFM6P2zkVNvlMvEl7p-levrO3tXf_USZvsR_Sr0bTe'
const iso = value => new Date(value).toISOString()
const clean = value => typeof value === 'string' ? value.trim() : ''
const dbFor = env => env.EBUY_DB?.withSession ? env.EBUY_DB.withSession('first-primary') : env.EBUY_DB
const error = (message, status = 400) => Object.assign(new Error(message), { status, safe: true })
const json = (body, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } })

export function fathomEnabled(env) {
  return env.FATHOM_ENABLED === 'true' && Boolean(env.FATHOM_API_KEY && env.AI && env.EBUY_DB && env.FATHOM_OWNER_EMAIL && Number.isFinite(Date.parse(env.FATHOM_ACTIVATED_AT)))
}

export function eligibleMeeting(meeting, env, now = Date.now()) {
  const end = Date.parse(meeting?.recording_end_time)
  const start = Date.parse(meeting?.recording_start_time)
  const activated = Date.parse(env.FATHOM_ACTIVATED_AT)
  return /^\d{1,20}$/.test(String(meeting?.recording_id)) &&
    [meeting?.title, meeting?.meeting_title].some(t => /^TAG\s+Capture$/i.test(clean(t))) &&
    clean(meeting?.recorded_by?.email).toLowerCase() === clean(env.FATHOM_OWNER_EMAIL).toLowerCase() &&
    Number.isFinite(activated) && Number.isFinite(start) && start <= end && end >= activated && end <= now && end + HOURS_48 > now
}

export async function boundedBody(request, maxBytes = 800000) {
  if (Number(request.headers.get('content-length')) > maxBytes) throw error('Meeting payload is too large', 413)
  const reader = request.body?.getReader()
  if (!reader) return ''
  const chunks = []
  let size = 0
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > maxBytes) { await reader.cancel(); throw error('Meeting payload is too large', 413) }
      chunks.push(value)
    }
  } finally { reader.releaseLock() }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
}

export async function verifyFathomSignature(req, raw, secret, now = Date.now()) {
  const id = req.headers.get('webhook-id') || ''
  const timestamp = req.headers.get('webhook-timestamp') || ''
  if (!secret || !id || !/^\d+$/.test(timestamp) || Math.abs(now / 1000 - Number(timestamp)) > 300) return false
  try {
    const bytes = Uint8Array.from(atob(secret.replace(/^whsec_/, '')), c => c.charCodeAt(0))
    const key = await crypto.subtle.importKey('raw', bytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['verify'])
    const signed = new TextEncoder().encode(`${id}.${timestamp}.${raw}`)
    for (const entry of (req.headers.get('webhook-signature') || '').split(/\s+/).slice(0, 8)) {
      const [version, encoded] = entry.split(',')
      if (version !== 'v1' || !encoded) continue
      const signature = Uint8Array.from(atob(encoded), c => c.charCodeAt(0))
      if (await crypto.subtle.verify('HMAC', key, signature, signed)) return true
    }
  } catch { /* Invalid encoding, secret or signature. Never log payloads. */ }
  return false
}

async function readState(db, key, now = Date.now()) {
  const row = await db.prepare('SELECT payload_json, expires_at FROM crm_runtime_state WHERE state_key = ? AND expires_at > ?').bind(key, iso(now)).first()
  return row ? { value: JSON.parse(row.payload_json), raw: row.payload_json, expires: row.expires_at } : null
}

async function replaceState(db, key, before, value) {
  const result = await db.prepare('UPDATE crm_runtime_state SET payload_json = ?, updated_at = ? WHERE state_key = ? AND payload_json = ? AND expires_at > ?')
    .bind(JSON.stringify(value), iso(Date.now()), key, before.raw, iso(Date.now())).run()
  return result.meta.changes === 1
}

export async function enqueueMeeting(env, meeting, now = Date.now()) {
  if (!eligibleMeeting(meeting, env, now)) return { accepted: false, reason: 'outside_scope_or_retention' }
  const db = dbFor(env), id = String(meeting.recording_id), expires = iso(Date.parse(meeting.recording_end_time) + HOURS_48)
  // Whitelist content. No summaries, videos, invitee lists or unrelated fields.
  const input = {
    recording_id: id, recording_end_time: meeting.recording_end_time,
    share_url: meeting.share_url || meeting.url,
    transcript: Array.isArray(meeting.transcript) ? meeting.transcript : [],
    action_items: Array.isArray(meeting.action_items) ? meeting.action_items : [],
  }
  const payload = JSON.stringify(input)
  if (new TextEncoder().encode(payload).length > 650000) throw error('Meeting transcript exceeds the processing size limit', 413)
  const stamp = iso(now)
  const results = await db.batch([
    db.prepare('INSERT OR IGNORE INTO crm_runtime_state (state_key, category, payload_json, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').bind(`fathom:input:${id}`, 'fathom-input', payload, expires, stamp, stamp),
    db.prepare('INSERT OR IGNORE INTO crm_runtime_state (state_key, category, payload_json, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').bind(`fathom:job:${id}`, 'fathom-job', JSON.stringify({ id, ended: input.recording_end_time, status: 'queued', nextAt: 0, attempts: 0, state: null }), expires, stamp, stamp),
  ])
  return { accepted: true, duplicate: results[1].meta.changes === 0 }
}

async function fathomGet(env, path) {
  const response = await fetch(`https://api.fathom.ai/external/v1${path}`, { headers: { 'X-Api-Key': env.FATHOM_API_KEY }, signal: AbortSignal.timeout(25000), redirect: 'error' })
  if (!response.ok) { await response.body?.cancel(); throw error(`Fathom is temporarily unavailable (${response.status})`, 503) }
  return JSON.parse(await boundedBody(response, 4000000))
}

async function recoverMeetings(env) {
  // Recovery scans only the active 48-hour window, hourly, and resumes pages.
  // The cursor expires too. Repeated webhooks cannot extend meeting retention.
  const db = dbFor(env), key = 'fathom:recovery', now = Date.now()
  let before = await readState(db, key)
  if (before && before.value.nextAt > now) return
  if (!before) {
    await db.prepare('INSERT OR IGNORE INTO crm_runtime_state (state_key,category,payload_json,expires_at,created_at,updated_at) VALUES (?,?,?,?,?,?)')
      .bind(key, 'fathom-control', '{"nextAt":0}', iso(now + HOURS_48), iso(now), iso(now)).run()
    before = await readState(db, key)
  }
  if (!before || !await replaceState(db, key, before, { ...before.value, nextAt: now + 300000 })) return
  const locked = await readState(db, key)
  const windowFrom = before.value.cursor ? before.value.windowFrom : iso(Math.max(now - HOURS_48, Date.parse(env.FATHOM_ACTIVATED_AT)))
  const windowTo = before.value.cursor ? before.value.windowTo : iso(now)
  const url = new URL('https://api.fathom.ai/external/v1/meetings')
  url.searchParams.set('created_after', windowFrom)
  url.searchParams.set('created_before', windowTo)
  url.searchParams.set('include_action_items', 'true')
  url.searchParams.append('recorded_by[]', env.FATHOM_OWNER_EMAIL)
  if (before.value.cursor) url.searchParams.set('cursor', before.value.cursor)
  try {
    const payload = await fathomGet(env, `/meetings?${url.searchParams}`)
    for (const meeting of payload.items || []) if (eligibleMeeting(meeting, env)) await enqueueMeeting(env, meeting)
    await replaceState(db, key, locked, { cursor: payload.next_cursor || null, windowFrom, windowTo, nextAt: now + (payload.next_cursor ? 300000 : 3600000) })
  } catch (e) {
    await replaceState(db, key, locked, { ...before.value, nextAt: now + 900000, error: 'Meeting recovery could not complete. It will retry automatically.' })
  }
}

export async function runFathomJobs(env) {
  if (!env.EBUY_DB) return
  const db = dbFor(env), now = Date.now()
  // Small category-scoped deletion; no KV and no new table. Logical expiry is
  // enforced on every read even if a scheduled cleanup is delayed.
  await db.prepare("DELETE FROM crm_runtime_state WHERE state_key IN (SELECT state_key FROM crm_runtime_state WHERE category IN ('fathom-input','fathom-job','fathom-proposal','fathom-control') AND expires_at <= ? LIMIT 200)").bind(iso(now)).run()
  if (!fathomEnabled(env)) return
  await recoverMeetings(env)
  const rows = await db.prepare("SELECT state_key, payload_json, expires_at FROM crm_runtime_state WHERE category = 'fathom-job' AND expires_at > ? AND json_extract(payload_json, '$.status') IN ('queued','processing') AND COALESCE(json_extract(payload_json, '$.nextAt'),0) <= ? ORDER BY created_at LIMIT 1").bind(iso(now), now).all()
  for (const row of rows.results || []) {
    const before = { raw: row.payload_json }, job = JSON.parse(row.payload_json)
    const lease = crypto.randomUUID()
    let current = { ...job, status: 'processing', nextAt: Date.now() + 270000, lease }
    if (!await replaceState(db, row.state_key, before, current)) continue
    // Bound CPU/subrequests and wall time. Persist each successful AI step.
    const started = Date.now()
    try {
      const sourceKey = `fathom:input:${job.id}`
      let input = await readState(db, sourceKey)
      if (!input) throw error('Meeting data expired', 410)
      if (!input.value.transcript?.length) {
        const payload = await fathomGet(env, `/recordings/${job.id}/transcript`)
        const updated = { ...input.value, transcript: payload.transcript || [] }
        if (!updated.transcript.length) throw error('The meeting transcript is not ready', 503)
        if (new TextEncoder().encode(JSON.stringify(updated)).length > 650000) throw error('Meeting transcript exceeds the processing size limit', 413)
        await replaceState(db, sourceKey, input, updated)
        input = { ...input, value: updated }
      }
      for (let step = 0; step < 4 && Date.now() - started < 150000; step++) {
        if (Date.now() >= Date.parse(row.expires_at)) break
        const next = await advanceAnalysis(input.value, current.state, async (system, user) => {
          const instructions = system + (current.attempts ? '\nA prior response failed validation. Copy exact source IDs and quotes. Use not_a_task when no real commitment exists; never fabricate evidence. Return the complete JSON object only.' : '')
          let result
          try {
            result = await env.AI.run(FATHOM_MODEL, { messages: [{ role: 'system', content: instructions }, { role: 'user', content: user }], response_format: { type: 'json_object' }, temperature: 0, max_tokens: 6500 }, { signal: AbortSignal.timeout(90000) })
          } catch (failure) {
            if (/429|rate.?limit|quota|daily.*limit|neurons/i.test(String(failure?.message || failure))) throw Object.assign(error('Workers AI capacity is temporarily unavailable.', 503), { rateLimited: true })
            throw failure
          }
          return extractModelOutput(result)
        })
        const updated = { ...current, state: next, attempts: 0, nextAt: Date.now() + 270000 }
        if (!await replaceState(db, row.state_key, { raw: JSON.stringify(current) }, updated)) break
        current = updated
        if (next.phase === 'done') {
          // INSERT OR IGNORE makes interrupted publication and replay safe.
          const stamp = iso(Date.now())
          const writes = next.proposals.map((task, index) => {
            const id = `${job.id}:${index}`
            return db.prepare('INSERT OR IGNORE INTO crm_runtime_state (state_key,category,payload_json,expires_at,created_at,updated_at) VALUES (?,?,?,?,?,?)')
              .bind(`fathom:proposal:${id}`, 'fathom-proposal', JSON.stringify({ ...task, id, meetingId: job.id, ended: job.ended, status: 'pending', needsReview: task.status === 'uncertain', taskId: `F_${job.id}_${index}` }), row.expires_at, stamp, stamp)
          })
          if (writes.length) await db.batch(writes)
          await replaceState(db, row.state_key, { raw: JSON.stringify(current) }, { id: job.id, ended: job.ended, status: 'done', proposalCount: next.proposals.length, excludedCount: next.excluded.length, issues: next.issues })
          // Release the transcript early after successful completion. The job
          // ID remains until its original expiry to suppress duplicate delivery.
          await db.prepare('DELETE FROM crm_runtime_state WHERE state_key = ?').bind(sourceKey).run()
          break
        }
      }
      if (current.state?.phase !== 'done') await replaceState(db, row.state_key, { raw: JSON.stringify(current) }, { ...current, nextAt: Date.now() + 60000 })
    } catch (e) {
      const attempts = (current.attempts || 0) + 1
      // Provider messages may contain transcript text. Store only safe status.
      await replaceState(db, row.state_key, { raw: JSON.stringify(current) }, { ...current, attempts, status: !e.rateLimited && attempts >= 4 ? 'attention' : 'queued', nextAt: Date.now() + Math.min(3600000, (e.rateLimited ? 300000 : 30000) * 2 ** Math.min(attempts, 7)), error: 'Meeting processing could not complete. Available proposals remain safe; retry from the review queue.' })
      console.warn(JSON.stringify({ event: 'fathom_processing_retry', meetingId: job.id, attempts }))
    }
  }
}

export function validateTaskEdit(data) {
  const title = clean(data.title), description = clean(data.description), opportunityId = clean(data.opportunityId), assignee = clean(data.assignee), dueDate = clean(data.dueDate)
  if (!title || title.length > 250 || description.length > 5000 || !opportunityId || opportunityId.length > 250 || !assignee || assignee.length > 250) throw error('Choose an opportunity and assignee, and enter a task title.')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate) || !Number.isFinite(Date.parse(dueDate)) || iso(Date.parse(dueDate)).slice(0, 10) !== dueDate) throw error('Choose a valid due date.')
  return { title, description, opportunityId, assignee, dueDate, includeMeetingLink: data.includeMeetingLink === true }
}

async function approveProposal(req, env, identity, id, body) {
  const db = dbFor(env), key = `fathom:proposal:${id}`
  let before = await readState(db, key)
  if (!before) throw error('This task proposal has expired or no longer exists.', 410)
  if (before.value.status === 'approved') return json({ approved: true, taskId: before.value.taskId, alreadyExisted: true })
  if (before.value.status === 'rejected') throw error('This task proposal was rejected.', 409)
  const token = req.headers.get('Authorization').replace(/^Bearer\s+/i, '')
  const drive = env.WORKBOOK_DRIVE_ID || DRIVE
  // Reconcile an uncertain earlier append. NEVER issue a second append when
  // the first could have succeeded. This protects against double clicks/users.
  if (before.value.status === 'approving' && before.value.writeStarted) {
    const tasks = await readWorkbookTable(env, drive, token, 'TasksTable')
    if (!tasks.some(t => t.TaskID === before.value.taskId)) throw error('The earlier save could not be confirmed. Check the workbook before retrying; the CRM will not create a duplicate.', 409)
    await replaceState(db, key, before, { ...before.value, status: 'approved' })
    return json({ approved: true, taskId: before.value.taskId, alreadyExisted: true })
  }
  if (before.value.status === 'approving' && before.value.leaseUntil > Date.now()) throw error('Another save is already in progress.', 409)
  const edit = validateTaskEdit(body)
  let current = { ...before.value, edit, status: 'approving', leaseUntil: Date.now() + 180000, writeStarted: false }
  if (!await replaceState(db, key, before, current)) throw error('This proposal changed. Refresh the review queue.', 409)
  try {
    const [pipeline, recipients, tasks, columns] = await Promise.all([
      readWorkbookTable(env, drive, token, 'PipelineTable'),
      readWorkbookTable(env, drive, token, 'NotificationRecipientsTable'),
      readWorkbookTable(env, drive, token, 'TasksTable'),
      graphWorkbookFetch(env, drive, token, '/tables/TasksTable/columns'),
    ])
    const matches = pipeline.filter(p => (p['Opportunity ID'] || p['Contract Number / Notice ID']) === edit.opportunityId && !['yes','true','1'].includes(String(p.Archived || '').toLowerCase()))
    if (matches.length !== 1) throw error('Select one current pipeline opportunity.', 409)
    if (!recipients.some(r => r['Pipeline Assignee'] === edit.assignee)) throw error('Select an assignee from the notification user list.')
    const opportunity = matches[0]
    const headers = (columns.value || []).map(c => c.name)
    for (const required of ['TaskID','ContractNumber','Title','Description','AssignedTo','DueDate','Status']) if (!headers.includes(required)) throw error('TasksTable is missing a required column. Open Tasks in the CRM to check its setup.', 409)
    const existing = tasks.find(t => t.TaskID === current.taskId)
    const record = {
      TaskID: current.taskId, ContractNumber: opportunity['Contract Number / Notice ID'], ContractTitle: opportunity['Project Title / Description*'],
      OpportunityNotes: '', Title: edit.title, Description: edit.description + (edit.includeMeetingLink && current.meetingReference?.url ? `\n\nMeeting: ${current.meetingReference.url}` : ''),
      AssignedTo: edit.assignee, DueDate: edit.dueDate, Priority: 'Medium', Status: 'To Do',
      CreatedBy: identity.displayName || identity.userPrincipalName, CreatedDate: iso(Date.now()).slice(0,10), UpdatedDate: iso(Date.now()).slice(0,10),
    }
    if (!existing) {
      const updated = { ...current, writeStarted: true }
      if (!await replaceState(db, key, { raw: JSON.stringify(current) }, updated)) throw error('This proposal expired or changed before saving.', 409)
      current = updated
      // Literal strings prevent spreadsheet-formula injection from model text.
      const cell = v => typeof v === 'string' && /^[=+@-]/.test(v) ? `'${v}` : v ?? ''
      await graphWorkbookFetch(env, drive, token, '/tables/TasksTable/rows/add', { method: 'POST', body: JSON.stringify({ values: [headers.map(h => cell(record[h]))] }), signal: AbortSignal.timeout(60000) })
    }
    await replaceState(db, key, { raw: JSON.stringify(current) }, { ...current, status: 'approved' })
    return json({ approved: true, taskId: current.taskId, alreadyExisted: Boolean(existing), task: existing || record })
  } catch (e) {
    if (!current.writeStarted) await replaceState(db, key, { raw: JSON.stringify(current) }, { ...current, status: 'pending', leaseUntil: 0 })
    if (e.safe) throw e
    throw error(current.writeStarted ? 'The task save could not be confirmed. Retry to check the workbook without creating a duplicate.' : 'The workbook could not be read. No task was created. Please retry.', 503)
  }
}

export async function handleFathom(req, env, identity = null) {
  const path = new URL(req.url).pathname
  try {
    if (path === '/fathom/webhook' && req.method === 'POST') {
      const raw = await boundedBody(req)
      if (!await verifyFathomSignature(req, raw, env.FATHOM_WEBHOOK_SECRET || env.WEBHOOK_SECRET)) return json({ error: 'Invalid webhook signature' }, 401)
      if (!fathomEnabled(env)) return json({ accepted: false, reason: 'disabled' }, 503)
      let meeting
      try { meeting = JSON.parse(raw) } catch { throw error('Invalid webhook payload') }
      return json(await enqueueMeeting(env, meeting), 202)
    }
    if (!identity) return json({ error: 'Sign in to review meeting tasks' }, 401)
    if (!fathomEnabled(env)) return req.method === 'GET'
      ? json({ enabled: false, proposals: [], jobs: [] })
      : json({ error: 'Fathom task processing is not enabled.' }, 503)
    const db = dbFor(env)
    if (path === '/fathom/review' && req.method === 'GET') {
      const rows = await db.prepare("SELECT category, payload_json, expires_at FROM crm_runtime_state WHERE category IN ('fathom-proposal','fathom-job','fathom-control') AND expires_at > ? ORDER BY created_at DESC LIMIT 250").bind(iso(Date.now())).all()
      const proposals = [], jobs = []
      let recoveryIssue = null
      for (const row of rows.results || []) {
        const value = JSON.parse(row.payload_json)
        if (row.category === 'fathom-proposal' && ['pending','approving'].includes(value.status)) proposals.push({ ...value, edit: undefined, expiresAt: row.expires_at })
        if (row.category === 'fathom-job' && value.status !== 'done') jobs.push({ id: value.id, status: value.status, ended: value.ended, error: value.error || null, phase: value.state?.phase || 'queued', reviewed: value.state?.index || 0, expiresAt: row.expires_at })
        if (row.category === 'fathom-control') recoveryIssue = value.error || null
      }
      return json({ enabled: true, proposals, jobs, recoveryIssue })
    }
    const match = path.match(/^\/fathom\/proposals\/(\d+:\d+)\/(approve|reject)$/)
    if (match && req.method === 'POST') {
      if (match[2] === 'approve') return await approveProposal(req, env, identity, match[1], JSON.parse(await boundedBody(req, 12000)))
      const key = `fathom:proposal:${match[1]}`, before = await readState(db, key)
      if (!before) throw error('This proposal expired.', 410)
      if (before.value.status !== 'pending') throw error('This proposal is already being handled.', 409)
      if (!await replaceState(db, key, before, { ...before.value, status: 'rejected' })) throw error('This proposal changed. Refresh the queue.', 409)
      return json({ rejected: true })
    }
    const retry = path.match(/^\/fathom\/jobs\/(\d+)\/retry$/)
    if (retry && req.method === 'POST') {
      const key = `fathom:job:${retry[1]}`, before = await readState(db, key)
      if (!before) throw error('The meeting expired.', 410)
      if (before.value.status !== 'attention') throw error('This meeting is already processing.', 409)
      if (!await replaceState(db, key, before, { ...before.value, attempts: 0, status: 'queued', nextAt: 0, error: null })) throw error('The meeting changed. Refresh the queue.', 409)
      return json({ queued: true })
    }
    return json({ error: 'Not found' }, 404)
  } catch (e) {
    console.warn(JSON.stringify({ event: 'fathom_request_failed', status: e.safe ? e.status : 503 }))
    return json({ error: e.safe ? e.message : 'Fathom tasks are temporarily unavailable. Please retry.' }, e.safe ? e.status : 503)
  }
}
