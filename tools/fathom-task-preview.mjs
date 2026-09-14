// Read-only Fathom / Workers AI experiment. No database, webhook or task writes.
// Meeting content lives only in memory. Running this file requires --live.
import fs from 'node:fs'
import os from 'node:os'
import { pathToFileURL } from 'node:url'

import { advanceAnalysis, extractModelOutput } from '../workers/tag-pipeline-api/src/lib/fathomAnalysis.js'
export * from '../workers/tag-pipeline-api/src/lib/fathomAnalysis.js'
const MODEL = process.env.FATHOM_TEST_MODEL || '@cf/openai/gpt-oss-120b'
const array = value => Array.isArray(value) ? value : []

function secret(source, name) {
  const value = source.match(new RegExp(`^\\s*${name}\\s*=\\s*(.*)$`, 'm'))?.[1]?.trim()
  return value?.replace(/^(['"])(.*)\1$/, '$2')
}

async function main() {
  if (!process.argv.includes('--live')) throw new Error('Use --live to explicitly authorize historical preview samples')
  const vars = fs.readFileSync(new URL('../workers/tag-pipeline-api/.dev.vars', import.meta.url), 'utf8')
  const fathomKey = secret(vars, 'FATHOM_API_KEY')
  const auth = fs.readFileSync(`${os.homedir()}/Library/Preferences/.wrangler/config/default.toml`, 'utf8')
  const token = process.env.CLOUDFLARE_API_TOKEN || secret(auth, 'oauth_token')
  const account = process.env.CLOUDFLARE_ACCOUNT_ID
  if (!fathomKey || !token || !account) throw new Error('Fathom key, Cloudflare authentication and account ID are required')
  let neurons = 0, calls = 0
  const runAI = async (system, user) => {
    if (neurons >= 3500 || calls >= 30) { const e = new Error('Preview resource budget reached'); e.stopRun = true; throw e }
    calls++
    const started = Date.now()
    let response, payload
    try {
      response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/ai/run/${MODEL}`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        // Reasoning models consume this allowance for reasoning AND final JSON.
        // A short visible answer can still require a larger total output budget.
        body: JSON.stringify({ messages: [{ role: 'system', content: system }, { role: 'user', content: user }], response_format: { type: 'json_object' }, temperature: 0, max_tokens: 6500 }),
        signal: AbortSignal.timeout(120000),
      })
      payload = await response.json()
    } catch {
      // A timeout may still consume provider capacity. Do not retry it as a
      // JSON validation failure or count the unknown usage as zero.
      const e = new Error('Workers AI transport failed; usage is unknown. Preview stopped to preserve shared capacity.')
      e.stopRun = true
      throw e
    }
    if (!response.ok || payload.success === false) {
      const e = new Error(`Workers AI request failed (${response.status}); no provider fallback`)
      e.stopRun = true
      throw e
    }
    neurons += Number(payload.result?.usage?.neurons || 0)
    console.log(JSON.stringify({ phase: 'ai_complete', call: calls, seconds: (Date.now() - started) / 1000, cumulativeNeurons: neurons }))
    const answer = extractModelOutput(payload.result)
    if (process.env.FATHOM_TEST_DIAGNOSTICS === 'true') console.log(JSON.stringify(answer))
    return answer
  }
  // Deliberate historical TEST exception. Never import these into a live queue.
  const samples = [{ id: 180851894, day: '2026-09-08', next: '2026-09-09' }, { id: 179196227, day: '2026-09-02', next: '2026-09-03' }, { id: 174350832, day: '2026-08-18', next: '2026-08-19' }]
  for (const sample of samples.filter(s => !process.env.FATHOM_SAMPLE_ID || String(s.id) === process.env.FATHOM_SAMPLE_ID)) {
    const url = new URL('https://api.fathom.ai/external/v1/meetings')
    for (const [k, v] of Object.entries({ created_after: `${sample.day}T00:00:00Z`, created_before: `${sample.next}T00:00:00Z`, include_action_items: 'true', include_transcript: 'true' })) url.searchParams.set(k, v)
    const response = await fetch(url, { headers: { 'X-Api-Key': fathomKey }, signal: AbortSignal.timeout(30000) })
    if (!response.ok) throw new Error(`Fathom request failed (${response.status})`)
    const payload = await response.json()
    const meeting = array(payload.items).find(m => m.recording_id === sample.id)
    if (!meeting) throw new Error('Requested sample not returned; no substitute meeting selected')
    const started = Date.now()
    let preview
    try {
      for (let step = 0; step < 70; step++) {
        let completed = false
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            preview = await advanceAnalysis({ ...meeting, analysisVersion: 3 }, preview, (system,user) => runAI(system + (attempt ? '\nA prior response failed validation. Copy exact source IDs and quotes. Never fabricate evidence. Return the complete JSON object only.' : ''),user))
            completed = true
            break
          } catch (e) {
            if (e.stopRun || attempt === 2) throw e
            console.log(JSON.stringify({ phase:'retry_validation', sample:sample.id, attempt:attempt+1, reason:e.message }))
          }
        }
        if (!completed) throw new Error('Sample could not complete')
        console.log(JSON.stringify({ phase: preview.phase, index: preview.index, sample: sample.id }))
        if (preview.phase === 'done') break
      }
      if (preview?.phase !== 'done') throw new Error('Preview step limit reached before completion')
    } catch (error) {
      // Make completed suggestions reviewable even if a later step fails.
      // Never print internal candidates, transcript excerpts or credentials.
      console.log(JSON.stringify({ date: sample.day, meetingId: sample.id, complete: false,
        phase: preview?.phase || 'discover', index: preview?.index || 0,
        proposals: preview?.proposals || [], excluded: preview?.excluded || [],
        measuredNeurons: neurons, calls, reviewRequired: true }))
      throw error
    }
    console.log(JSON.stringify({
      date: sample.day, seconds: (Date.now() - started) / 1000,
      meetingId: sample.id,
      proposals: preview.proposals,
      excluded: preview.excluded.map(task => ({ title: task.title, status: task.status })),
      issues: preview.issues, reviewRequired: true,
    }))
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1 })
}
