import test from 'node:test'
import assert from 'node:assert/strict'
import { prepareMeeting, parseOutput, sourceEvidence, verificationContext, normalizeVerification, analyzeMeeting, taskPreview, extractModelOutput, discoveryWindows, advanceAnalysis } from '../tools/fathom-task-preview.mjs'

const fixture = () => ({ recording_id: 1, recording_end_time: '2026-09-10T17:00:00Z', action_items: [], transcript: [
  { timestamp: '00:01:00', speaker: { display_name: 'Alex' }, text: 'My subscription expired.' },
  { timestamp: '00:01:10', speaker: { display_name: 'Jamie' }, text: "I will renew it." },
  { timestamp: '00:01:20', speaker: { display_name: 'Jamie' }, text: 'The latest will be tomorrow.' },
  { timestamp: '00:15:00', speaker: { display_name: 'Alex' }, text: 'Create the folder.' },
  { timestamp: '00:16:00', speaker: { display_name: 'Alex' }, text: 'Yes, I have saved the folder.' },
] })
const verification = () => ({ title: 'Renew subscription', status: 'outstanding', category: 'administrative', commitment: [{ id: 'S1', quote: 'I will renew it.' }], lifecycle: [], assigneeId: 'P1', assigneeEvidence: [{ id: 'S1', quote: 'I will renew it.' }], deadline: { id: 'S2', quote: 'latest will be tomorrow' }, deadlineScanComplete: true, unresolvedDeadlineIds: [], reviewNotes: [] })

test('quotes must exist at their cited source, not merely elsewhere', () => {
  const { lines } = prepareMeeting(fixture())
  assert.throws(() => sourceEvidence([{ id: 'S0', quote: 'I will renew it.' }], lines))
  assert.throws(() => sourceEvidence([{ id: 'S999', quote: 'Unknown' }], lines))
  assert.equal(sourceEvidence([{ id: 'S1', quote: 'I will renew it.' }], lines)[0].timestamp, '00:01:10')
})
test('evidence diagnostics distinguish failure causes without disclosing transcript text', () => {
  const { lines } = prepareMeeting(fixture())
  assert.throws(() => sourceEvidence([{ id: 'S999', quote: 'private content' }], lines), /source ID is absent/)
  assert.throws(() => sourceEvidence([{ id: 'S1', quote: '' }], lines), /quote is empty/)
  assert.throws(() => sourceEvidence([{ id: 'S1', quote: 'I will renew it. The latest will be tomorrow.' }], lines), /not an exact substring/)
  assert.throws(() => sourceEvidence([{ id: 1, quote: 'I will renew it.' }], lines), /source ID is absent/)
})
test('explicit monitoring commitment can remain a proposal without guessing an owner', async () => {
  const meeting = { ...fixture(), transcript: [{ timestamp: '00:01:00', speaker: { display_name: 'Alex' }, text: 'We decided not to bid, but we still need to track the award.' }] }
  let calls = 0
  const result = await analyzeMeeting(meeting, async system => {
    if (++calls <= 2) {
      if (calls === 1) assert.match(system, /continue tracking or monitoring/)
      return { candidates: [{ title: 'Track the award', evidenceIds: ['S0'] }] }
    }
    assert.match(system, /Lack of a named owner/)
    assert.match(system, /Mentioning an email address does not itself/)
    return { ...verification(), title: 'Track the award', commitment: [{ id: 'S0', quote: 'we still need to track the award.' }], assigneeId: null, assigneeEvidence: [], deadline: null }
  })
  assert.equal(result.proposals.length, 1)
  assert.equal(result.proposals[0].suggestedAssignee, null)
  assert.equal(result.proposals[0].opportunityId, null)
})
test('deadline outside commitment line and accepting speaker are preserved', () => {
  const m = prepareMeeting(fixture())
  const result = normalizeVerification({}, verification(), m, m.lines)
  assert.equal(result.suggestedAssignee.name, 'Jamie')
  assert.equal(result.assigneeId, null)
  assert.equal(result.opportunityId, null)
  assert.equal(result.dueDate, '2026-09-11')
  assert.equal(result.approved, false)
})
test('problem owner is not automatically assigned the task', () => {
  const m = prepareMeeting(fixture()), v = verification()
  v.assigneeId = 'P0'; v.assigneeEvidence = [{ id: 'S0', quote: 'My subscription expired.' }]
  assert.equal(normalizeVerification({}, v, m, m.lines).suggestedAssignee, null)
})
test('uncertain deadline does not silently become a three-day default', () => {
  const m = prepareMeeting(fixture()), v = verification()
  v.deadline = null; v.unresolvedDeadlineIds = ['S2']
  assert.equal(normalizeVerification({}, v, m, m.lines).dueDate, null)
  v.unresolvedDeadlineIds = []
  assert.equal(normalizeVerification({}, v, m, m.lines).dueDate, '2026-09-13')
})
test('context includes later mentions and surrounding completion', () => {
  const m = prepareMeeting(fixture())
  assert.deepEqual(verificationContext({ title: 'Create folder', evidenceIds: ['S3'] }, m).map(l => l.id), ['S3', 'S4'])
})
test('malformed JSON and unsupported task evidence fail closed', () => {
  assert.throws(() => parseOutput('{'))
  assert.throws(() => parseOutput([]))
  const m = prepareMeeting(fixture()), v = verification()
  v.commitment = []
  assert.throws(() => normalizeVerification({}, v, m, m.lines))
  v.status = 'completed'
  assert.throws(() => normalizeVerification({}, v, m, m.lines))
})
test('completed work stays out of proposed tasks', async () => {
  let calls = 0
  const result = await analyzeMeeting(fixture(), async () => ++calls <= 2
    ? { candidates: [{ title: 'Create folder', evidenceIds: ['S3'] }] }
    : { title: 'Create folder', status: 'completed', category: 'internal', commitment: [{ id: 'S3', quote: 'Create the folder.' }], lifecycle: [{ id: 'S4', quote: 'I have saved the folder.' }] })
  assert.equal(result.proposals.length, 0)
  assert.equal(result.excluded.length, 1)
})
test('verification failures stay visible instead of becoming tasks', async () => {
  let calls = 0
  const result = await analyzeMeeting(fixture(), async () => ++calls <= 2
    ? { candidates: [{ title: 'Renew subscription', evidenceIds: ['S0'] }] }
    : { ...verification(), commitment: [{ id: 'S400', quote: 'Made up' }] })
  assert.equal(result.proposals.length, 0)
  assert.equal(result.issues.length, 1)
})
test('user preview includes only optional meeting link, not transcript evidence', () => {
  const m = prepareMeeting(fixture())
  const task = normalizeVerification({}, verification(), m, m.lines)
  const preview = taskPreview(task, 'https://fathom.video/share/example')
  assert.equal(preview.meetingReference.optional, true)
  assert.equal(preview.meetingReference.include, true)
  for (const key of ['commitment', 'lifecycle', 'assigneeEvidence', 'deadlineEvidence', 'reviewNotes']) assert.equal(key in preview, false)
  assert.equal(JSON.stringify(preview).includes('I will renew it.'), false)
  assert.equal(taskPreview(task, 'https://untrusted.example/').meetingReference, null)
})
test('both Workers AI response shapes work; truncated reasoning output is explicit', () => {
  assert.equal(extractModelOutput({ response: '{}' }), '{}')
  assert.equal(extractModelOutput({ choices: [{ finish_reason: 'stop', message: { content: '{}' } }] }), '{}')
  assert.throws(() => extractModelOutput({ choices: [{ finish_reason: 'length', message: { content: null } }] }), /budget exhausted/)
  assert.throws(() => extractModelOutput({ choices: [{ finish_reason: 'stop', message: { content: null } }] }), /no final answer/)
})

test('context windows cover every speaker turn without cutting sentences', () => {
  const lines = Array.from({length:100}, (_,i)=>({id:`S${i}`,speaker:'P0',timestamp:`00:${String(i%60).padStart(2,'0')}:00`,text:'A complete speaker turn. '.repeat(5)}))
  const windows = discoveryWindows(lines,1200)
  assert.ok(windows.length>1)
  assert.deepEqual([...new Set(windows.flat().map(l=>l.id))],lines.map(l=>l.id))
  assert.throws(()=>discoveryWindows([{id:'S0',text:'x'.repeat(5000)}],1000),/too large/)
})
test('speculation and existing meeting logistics are not task commitments', () => {
  const m = prepareMeeting({ ...fixture(), transcript:[{timestamp:'00:01:00',speaker:{display_name:'Alex'},text:'What are the chances that they extend the deadline?'}] })
  const v = { ...verification(), title:'Check for deadline extension', commitment:[{id:'S0',quote:m.lines[0].text}], deadline:null, assigneeId:null, assigneeEvidence:[] }
  assert.equal(normalizeVerification({},v,m,m.lines).status,'not_a_task')
  m.lines[0].text="We'll talk again at two."
  v.title='Hold follow-up meeting'; v.commitment=[{id:'S0',quote:m.lines[0].text}]
  assert.equal(normalizeVerification({},v,m,m.lines).status,'not_a_task')
})
test('checkpoint resumes the same candidate after a failed AI call', async () => {
  const m=fixture(), candidate={title:'Renew subscription',evidenceIds:['S1'],actionIndexes:[],searchTerms:['subscription']}
  let state=await advanceAnalysis(m,null,async()=>({candidates:[candidate]}))
  state=await advanceAnalysis(m,state,async()=>({candidates:[candidate]}))
  const saved=structuredClone(state)
  await assert.rejects(advanceAnalysis(m,state,async()=>{throw Error('Rate limited')}))
  assert.deepEqual(state,saved)
  const result=await advanceAnalysis(m,state,async()=>verification())
  assert.equal(result.phase,'done')
  assert.equal(result.proposals.length,1)
  assert.equal(result.proposals[0].approved,false)
  assert.equal('commitment' in result.proposals[0],false)
})
