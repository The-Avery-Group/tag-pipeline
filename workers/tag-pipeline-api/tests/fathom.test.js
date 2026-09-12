import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { Miniflare } from 'miniflare'
import { eligibleMeeting, enqueueMeeting, handleFathom, verifyFathomSignature, boundedBody, runFathomJobs, validateTaskEdit } from '../src/handlers/fathom.js'

let mf, db
before(async () => {
  // Exercise SQLite/CAS on the locally bundled runtime; production keeps its
  // existing later compatibility date. No newer APIs are used by this fixture.
  mf = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("test") } }', compatibilityDate: '2026-07-01', d1Databases: ['DB'] })
  db = await mf.getD1Database('DB')
  const sql = await readFile(new URL('../migrations/0012_runtime_state.sql', import.meta.url), 'utf8')
  for (const statement of sql.split(';').filter(s => s.trim())) await db.prepare(statement).run()
})
after(async () => { await mf?.dispose() })
const envFor = () => ({ EBUY_DB: db, AI: {}, FATHOM_API_KEY: 'test', FATHOM_ENABLED: 'true', FATHOM_OWNER_EMAIL: 'owner@example.com', FATHOM_ACTIVATED_AT: new Date(Date.now() - 86400000).toISOString(), WORKBOOK_ID: 'workbook' })
const meeting = id => ({ recording_id: id, title: 'TAG Capture', recorded_by: { email: 'owner@example.com' }, recording_start_time: new Date(Date.now() - 3600000).toISOString(), recording_end_time: new Date(Date.now() - 1800000).toISOString(), share_url: 'https://fathom.video/share/test', transcript: [{ speaker: { display_name: 'Jamie', matched_calendar_invitee_email: 'jamie@example.com' }, timestamp: '00:01:00', text: 'I will send the revised proposal.' }], action_items: [] })
const put = async (key, category, value, expires = Date.now() + 3600000) => db.prepare('INSERT OR REPLACE INTO crm_runtime_state VALUES (?,?,?,?,?,?)').bind(key, category, JSON.stringify(value), new Date(expires).toISOString(), new Date().toISOString(), new Date().toISOString()).run()
const row = key => db.prepare('SELECT * FROM crm_runtime_state WHERE state_key = ?').bind(key).first()
const identity = { displayName: 'Reviewer', userPrincipalName: 'reviewer@example.com' }
const edit = { title: 'Send proposal', description: 'Prepare the requested proposal.', opportunityId: 'O_123', assignee: 'Jamie', dueDate: '2026-09-15', includeMeetingLink: false }
const request = (path, body) => new Request(`https://crm.test${path}`, { method: body ? 'POST' : 'GET', headers: { Authorization: 'Bearer user-test-token', 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
const proposal = id => ({ id, meetingId: id.split(':')[0], status: 'pending', taskId: `F_${id.replace(':','_')}`, title: 'Send proposal', meetingReference: { url: 'https://fathom.video/share/test' } })

test('only current TAG Capture meetings owned by the configured user are eligible', () => {
  const env = envFor(), m = meeting(1)
  assert.equal(eligibleMeeting(m, env), true)
  assert.equal(eligibleMeeting({ ...m, title: 'Daily Huddle' }, env), false)
  assert.equal(eligibleMeeting({ ...m, recorded_by: { email: 'teammate@example.com' } }, env), false)
  assert.equal(eligibleMeeting({ ...m, recording_end_time: new Date(Date.now()+60000).toISOString() }, env), false)
  assert.equal(eligibleMeeting(m, { ...env, FATHOM_ACTIVATED_AT: new Date().toISOString() }), false)
  assert.equal(eligibleMeeting(m, env, Date.parse(m.recording_end_time) + 48*3600000), false)
})
test('signature verifies raw body, version and timestamp; tampering and replay fail', async () => {
  const bytes = crypto.getRandomValues(new Uint8Array(32)), secret = 'whsec_' + Buffer.from(bytes).toString('base64')
  const timestamp = String(Math.floor(Date.now()/1000)), body = '{"title":"TAG Capture"}'
  const key = await crypto.subtle.importKey('raw', bytes, { name:'HMAC', hash:'SHA-256' }, false, ['sign'])
  const signature = Buffer.from(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`event1.${timestamp}.${body}`))).toString('base64')
  const req = new Request('https://crm.test', { headers: { 'webhook-id':'event1', 'webhook-timestamp':timestamp, 'webhook-signature':`v1,${signature}` } })
  assert.equal(await verifyFathomSignature(req,body,secret),true)
  assert.equal(await verifyFathomSignature(req,body+' ',secret),false)
  assert.equal(await verifyFathomSignature(req,body,secret,Date.now()+360000),false)
  assert.equal(await verifyFathomSignature(req,body,'bad-secret'),false)
})
test('chunked oversized bodies are rejected without trusting Content-Length', async () => {
  await assert.rejects(boundedBody(new Request('https://test', { method:'POST', body:'abcdef' }),5), /too large/)
  assert.equal(await boundedBody(new Request('https://test', { method:'POST', body:'abc' }),5),'abc')
})
test('simultaneous deliveries create one job and do not extend retention', async () => {
  const env = envFor(), m = meeting(101)
  const result = await Promise.all([enqueueMeeting(env,m),enqueueMeeting(env,m)])
  assert.equal(result.filter(r=>!r.duplicate).length,1)
  const initial = await row('fathom:job:101')
  await enqueueMeeting(env,m)
  assert.equal((await row('fathom:job:101')).expires_at, initial.expires_at)
  assert.equal(initial.expires_at,new Date(Date.parse(m.recording_end_time)+48*3600000).toISOString())
})
test('review and mutations require identity; unsigned webhook cannot enqueue', async () => {
  assert.equal((await handleFathom(request('/fathom/review'), envFor())).status,401)
  assert.equal((await handleFathom(request('/fathom/webhook',meeting(102)), envFor())).status,401)
  assert.equal(await row('fathom:job:102'),null)
})
test('review never returns expired proposals or transcript processing data', async () => {
  await put('fathom:proposal:103:0','fathom-proposal',proposal('103:0'),Date.now()-1000)
  await put('fathom:job:104','fathom-job',{ id:'104', status:'processing', state:{ transcript:'PRIVATE', candidates:[{title:'PRIVATE'}] } })
  const result = await (await handleFathom(request('/fathom/review'),envFor(),identity)).json()
  assert.equal(JSON.stringify(result).includes('PRIVATE'),false)
  assert.equal(result.proposals.some(p=>p.id==='103:0'),false)
})
test('cleanup removes expired temporary rows, not current rows or unrelated data', async () => {
  await put('fathom:input:105','fathom-input',{ transcript:'private' },Date.now()-1000)
  await put('other:105','other',{keep:true},Date.now()-1000)
  await runFathomJobs({ ...envFor(), FATHOM_ENABLED:'false' })
  assert.equal(await row('fathom:input:105'),null)
  assert.ok(await row('other:105'))
  assert.ok(await row('fathom:job:101'))
})
test('dates are validated, including impossible calendar dates', () => {
  assert.equal(validateTaskEdit(edit).dueDate,'2026-09-15')
  assert.throws(()=>validateTaskEdit({...edit,dueDate:'2026-02-31'}),/valid due date/)
  assert.throws(()=>validateTaskEdit({...edit,opportunityId:''}),/Choose an opportunity/)
})

function mockGraph(t, { failAppend = false, commitOnFailure = false, failReads = false } = {}) {
  const real = globalThis.fetch, saved = [], calls = { append: 0 }
  const tables = {
    PipelineTable: [{ 'Opportunity ID':'O_123','Contract Number / Notice ID':'RFQ-1','Project Title / Description*':'Actual opportunity', Archived:'' }],
    NotificationRecipientsTable: [{ 'Pipeline Assignee':'Jamie','Teams UPN / Entra Object ID':'jamie@example.com' }],
    TasksTable: saved,
  }
  const taskHeaders = ['TaskID','ContractNumber','ContractTitle','Title','Description','AssignedTo','DueDate','Status','CreatedBy']
  globalThis.fetch = async (url,options={}) => {
    assert.equal(options.headers.Authorization,'Bearer user-test-token')
    const path = new URL(url).pathname, name = path.match(/\/tables\/([^/]+)/)?.[1]
    assert.ok(name, 'only workbook requests are allowed')
    const headers = name==='TasksTable'?taskHeaders:Object.keys(tables[name][0])
    if (path.endsWith('/rows/add')) {
      calls.append++
      if (!failAppend || commitOnFailure) saved.push(Object.fromEntries(headers.map((h,i)=>[h,JSON.parse(options.body).values[0][i]])))
      if (failAppend) throw new Error('Simulated disconnected response')
      return Response.json({value:[]})
    }
    if (failReads) return Response.json({error:{message:'Read unavailable'}},{status:503})
    return Response.json({value:path.endsWith('/columns')?headers.map(name=>({name})):tables[name].map((r,index)=>({index,values:[headers.map(h=>r[h]||'')]}))})
  }
  t.after(()=>{globalThis.fetch=real})
  return {saved,calls}
}
test('approval uses actual workbook relationships and omits meeting link when unchecked', async t => {
  await put('fathom:proposal:110:0','fathom-proposal',proposal('110:0'))
  const {saved,calls} = mockGraph(t)
  const responses = await Promise.all([handleFathom(request('/fathom/proposals/110:0/approve',edit),envFor(),identity),handleFathom(request('/fathom/proposals/110:0/approve',edit),envFor(),identity)])
  assert.equal(responses.filter(r=>r.status===200).length,1)
  assert.equal(calls.append,1)
  assert.equal(saved[0].ContractNumber,'RFQ-1')
  assert.equal(saved[0].ContractTitle,'Actual opportunity')
  assert.equal(saved[0].Description,edit.description)
  assert.equal(saved[0].CreatedBy,'Reviewer')
  assert.equal((await handleFathom(request('/fathom/proposals/110:0/approve',edit),envFor(),identity)).status,200)
  assert.equal(calls.append,1)
})
test('ambiguous successful save is reconciled without a duplicate append', async t => {
  await put('fathom:proposal:111:0','fathom-proposal',proposal('111:0'))
  const {calls} = mockGraph(t,{failAppend:true,commitOnFailure:true})
  assert.equal((await handleFathom(request('/fathom/proposals/111:0/approve',edit),envFor(),identity)).status,503)
  assert.equal((await handleFathom(request('/fathom/proposals/111:0/approve',edit),envFor(),identity)).status,200)
  assert.equal(calls.append,1)
})
test('unknown save outcome blocks another append even when row is not yet visible', async t => {
  await put('fathom:proposal:112:0','fathom-proposal',proposal('112:0'))
  const {calls} = mockGraph(t,{failAppend:true})
  await handleFathom(request('/fathom/proposals/112:0/approve',edit),envFor(),identity)
  assert.equal((await handleFathom(request('/fathom/proposals/112:0/approve',edit),envFor(),identity)).status,409)
  assert.equal(calls.append,1)
})
test('failure before append restores pending status for a safe retry', async t => {
  await put('fathom:proposal:113:0','fathom-proposal',proposal('113:0'))
  const {calls} = mockGraph(t,{failReads:true})
  assert.equal((await handleFathom(request('/fathom/proposals/113:0/approve',edit),envFor(),identity)).status,503)
  assert.equal(JSON.parse((await row('fathom:proposal:113:0')).payload_json).status,'pending')
  assert.equal(calls.append,0)
})
test('rejection and expiry cannot produce tasks', async t => {
  const {calls} = mockGraph(t)
  await put('fathom:proposal:114:0','fathom-proposal',proposal('114:0'))
  assert.equal((await handleFathom(request('/fathom/proposals/114:0/reject',{}),envFor(),identity)).status,200)
  assert.equal((await handleFathom(request('/fathom/proposals/114:0/approve',edit),envFor(),identity)).status,409)
  await put('fathom:proposal:115:0','fathom-proposal',proposal('115:0'),Date.now()-1000)
  assert.equal((await handleFathom(request('/fathom/proposals/115:0/approve',edit),envFor(),identity)).status,410)
  assert.equal(calls.append,0)
})

test('background processing publishes review proposals, never live tasks, and releases transcripts', async t => {
  await db.prepare("DELETE FROM crm_runtime_state WHERE category IN ('fathom-job','fathom-input','fathom-proposal')").run()
  await put('fathom:recovery','fathom-control',{nextAt:Date.now()+3600000})
  const real=globalThis.fetch
  globalThis.fetch=async()=>{throw Error('Background processing must not access the workbook')}
  t.after(()=>{globalThis.fetch=real})
  let calls=0
  const env={...envFor(),AI:{run:async(model,input,options)=>{
    calls++
    assert.equal(model,'@cf/openai/gpt-oss-120b')
    assert.ok(options.signal)
    const system=input.messages[0].content
    return {response:system.startsWith('Find') || system.startsWith('Merge') ? {candidates:[{title:'Send revised proposal',evidenceIds:['S0'],actionIndexes:[],searchTerms:['proposal']}]}
      : {title:'Send revised proposal',description:'Send the revised proposal.',status:'outstanding',category:'capture',commitment:[{id:'S0',quote:'I will send the revised proposal.'}],lifecycle:[],assigneeId:'P0',assigneeEvidence:[{id:'S0',quote:'I will send the revised proposal.'}],deadline:null,deadlineScanComplete:true,unresolvedDeadlineIds:[]}}
  }}}
  const m=meeting(201)
  await enqueueMeeting(env,m)
  await Promise.all([runFathomJobs(env),runFathomJobs(env)])
  assert.equal(calls,3)
  assert.equal(JSON.parse((await row('fathom:job:201')).payload_json).status,'done')
  assert.equal(await row('fathom:input:201'),null)
  const result=JSON.parse((await row('fathom:proposal:201:0')).payload_json)
  assert.equal(result.status,'pending')
  assert.equal(result.approved,false)
  assert.equal(result.opportunityId,null)
  assert.equal(result.suggestedAssignee.email,'jamie@example.com')
  await enqueueMeeting(env,m)
  await runFathomJobs(env)
  assert.equal(calls,3)
})
test('rate limit retains checkpoints and uses no other AI provider', async () => {
  await db.prepare("DELETE FROM crm_runtime_state WHERE category IN ('fathom-job','fathom-input')").run()
  await put('fathom:recovery','fathom-control',{nextAt:Date.now()+3600000})
  const env={...envFor(),AI:{run:async()=>{throw Error('Private provider message with transcript must not be stored')}}}
  await enqueueMeeting(env,meeting(202))
  await runFathomJobs(env)
  const saved=JSON.parse((await row('fathom:job:202')).payload_json)
  assert.equal(saved.status,'queued')
  assert.equal(saved.attempts,1)
  assert.ok(saved.nextAt>Date.now())
  assert.ok(await row('fathom:input:202'))
  assert.equal(JSON.stringify(saved).includes('Private provider message'),false)
})
test('enabled flag blocks mutation rather than reporting false success', async () => {
  assert.equal((await handleFathom(request('/fathom/proposals/202:0/approve',edit),{...envFor(),FATHOM_ENABLED:'false'},identity)).status,503)
})
