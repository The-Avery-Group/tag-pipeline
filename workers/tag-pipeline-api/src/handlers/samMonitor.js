/**
 * Lightweight, checkpointed monitor for opportunities already saved in
 * NewOpportunitiesTable. It deliberately does not use Graph or the pull
 * handler, so checking SAM changes cannot make opportunity pulls slower.
 */

const SAM_BASE = 'https://api.sam.gov/opportunities/v2/search'
const WATCH_PREFIX = 'sam_monitor_watch:'
const RUN_KEY = 'sam_monitor_run'
const CHECK_BATCH_SIZE = 5
// Scheduled checks are intentionally larger than the interactive batches.
// A watch can require one notice lookup and one solicitation fallback, so 15
// still stays comfortably below the Free Workers external-subrequest limit.
const SCHEDULED_CHECK_BATCH_SIZE = 15
const DATE_RANGE_DAYS = 364

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
}

function normalized(value) { return String(value || '').trim().toUpperCase() }
function clean(value) { return String(value || '').trim() }

// `_001` and `-AMEND-01` are common amendment suffixes. Do not strip ordinary
// trailing digits: they can be a meaningful part of a solicitation number.
function solicitationFamily(value) {
  return normalized(value).replace(/(?:[_-](?:AMEND(?:MENT)?[_-]?)?\d{1,4})$/, '')
}

function titleTokens(value) {
  return new Set(clean(value).toLowerCase().match(/[a-z0-9]{3,}/g) || [])
}

function titleOverlap(a, b) {
  const left = titleTokens(a); const right = titleTokens(b)
  if (!left.size || !right.size) return 0
  let shared = 0
  left.forEach((token) => { if (right.has(token)) shared++ })
  return shared / Math.min(left.size, right.size)
}

function dateWindow() {
  const to = new Date(); to.setUTCDate(to.getUTCDate() + 1)
  const from = new Date(to); from.setUTCDate(from.getUTCDate() - DATE_RANGE_DAYS)
  const format = (date) => `${String(date.getUTCMonth() + 1).padStart(2, '0')}/${String(date.getUTCDate()).padStart(2, '0')}/${date.getUTCFullYear()}`
  return { from: format(from), to: format(to) }
}

function snapshot(record) {
  const contacts = Array.isArray(record?.pointOfContact) ? record.pointOfContact : []
  return {
    noticeId: clean(record?.noticeId),
    solicitationNumber: clean(record?.solicitationNumber),
    title: clean(record?.title),
    type: clean(record?.type),
    baseType: clean(record?.baseType),
    active: clean(record?.active),
    postedDate: clean(record?.postedDate || record?.posted),
    responseDate: clean(record?.responseDeadLine || record?.responseDeadline),
    setAside: clean(record?.typeOfSetAsideDescription || record?.typeOfSetAside),
    naics: clean(record?.naicsCode),
    organization: clean(record?.fullParentPathName),
    pointOfContact: contacts.map((p) => [p?.fullName || p?.fullname, p?.email, p?.phone].map(clean).join('|')).sort(),
    resourceLinks: (record?.resourceLinks || []).map(clean).filter(Boolean).sort(),
    additionalInfoLink: clean(record?.additionalInfoLink),
    uiLink: clean(record?.uiLink),
    modifiedDate: clean(record?.modifiedDate || record?.lastModifiedDate || record?.lastModified || record?.updatedDate),
  }
}

const LABELS = {
  title: 'title', type: 'notice type', baseType: 'base notice type', active: 'active status',
  responseDate: 'response date', setAside: 'set-aside', naics: 'NAICS', organization: 'organization',
  pointOfContact: 'point of contact', resourceLinks: 'attachments', additionalInfoLink: 'additional information',
  solicitationNumber: 'solicitation number', noticeId: 'notice ID',
  samUpdate: 'SAM notice update',
}

function differences(previous, next) {
  return Object.keys(LABELS).filter((key) => JSON.stringify(previous?.[key] ?? '') !== JSON.stringify(next?.[key] ?? ''))
}

function watchKey(item) {
  return `${WATCH_PREFIX}${normalized(item.noticeId || item['Notice ID']) || normalized(item.solicitationNumber || item['Solicitation Number'])}`
}

function toWatch(item, existing = null) {
  return {
    ...(existing || {}),
    // Keep the original KV key when an amendment is associated with an
    // existing watch. This prevents the old watch from becoming an orphan.
    key: existing?.key || watchKey(item),
    rowIndex: Number(item.rowIndex ?? item._rowIndex),
    noticeId: clean(item.noticeId ?? item['Notice ID']),
    solicitationNumber: clean(item.solicitationNumber ?? item['Solicitation Number']),
    title: clean(item.title ?? item.Title),
    department: clean(item.department ?? item.Department),
    agency: clean(item.agency ?? item.Agency),
    status: clean(item.status ?? item.Status).toLowerCase(),
    dateAdded: clean(item.dateAdded ?? item['Date Added']),
  }
}

function watchSource(watch) {
  return {
    key: watch.key,
    rowIndex: watch.rowIndex,
    noticeId: watch.noticeId,
    solicitationNumber: watch.solicitationNumber,
    title: watch.title,
    department: watch.department,
    agency: watch.agency,
    status: watch.status,
    dateAdded: watch.dateAdded,
  }
}

function sameWatchSource(left, right) {
  return JSON.stringify(watchSource(left)) === JSON.stringify(watchSource(right))
}

async function readWatch(env, key) {
  const text = await env.CACHE.get(key)
  try { return text ? JSON.parse(text) : null } catch { return null }
}

async function writeWatch(env, watch) {
  await env.CACHE.put(watch.key, JSON.stringify(watch))
}

async function listWatches(env) {
  const listed = await env.CACHE.list({ prefix: WATCH_PREFIX, limit: 1000 })
  const watches = await Promise.all(listed.keys.map(({ name }) => readWatch(env, name)))
  return watches.filter(Boolean)
}

async function fetchSAM(env, parameter, value) {
  const { from, to } = dateWindow()
  const params = new URLSearchParams({ api_key: env.SAM_API_KEY, postedFrom: from, postedTo: to, limit: '10', [parameter]: value })
  const response = await fetch(`${SAM_BASE}?${params}`)
  if (!response.ok) throw new Error(`SAM API error ${response.status}`)
  const data = await response.json()
  return data?.opportunitiesData || []
}

async function findCurrentRecord(env, watch) {
  const byNotice = watch.noticeId ? await fetchSAM(env, 'noticeid', watch.noticeId) : []
  if (byNotice.length) return byNotice.find((record) => normalized(record.noticeId) === normalized(watch.noticeId)) || byNotice[0]
  if (!watch.solicitationNumber) return null
  const bySolicitation = await fetchSAM(env, 'solnum', watch.solicitationNumber)
  return bySolicitation.find((record) => normalized(record.solicitationNumber) === normalized(watch.solicitationNumber)) || bySolicitation[0] || null
}

function publicWatch(watch) {
  return {
    rowIndex: watch.rowIndex,
    noticeId: watch.noticeId,
    solicitationNumber: watch.solicitationNumber,
    changed: Boolean(watch.change && !watch.change.reviewedAt),
    change: watch.change ? {
      fields: watch.change.fields || [],
      summary: watch.change.summary || '',
      changedAt: watch.change.changedAt,
      reviewedAt: watch.change.reviewedAt || null,
      uiLink: watch.change.uiLink || watch.snapshot?.uiLink || '',
    } : null,
    lastCheckedAt: watch.lastCheckedAt || null,
  }
}

async function sync(req, env) {
  const body = await req.json()
  const items = Array.isArray(body?.opportunities) ? body.opportunities : []
  const eligible = items.filter((item) => ['new', 'tracked', 'added_to_pipeline'].includes(clean(item.Status ?? item.status).toLowerCase()))
  if (eligible.length > 200) return json({ error: 'Too many opportunities to monitor at once' }, 400)

  const currentWatches = await listWatches(env)
  let synchronized = 0
  let unchanged = 0
  for (const item of eligible) {
    const notice = normalized(item['Notice ID'] ?? item.noticeId)
    const sol = normalized(item['Solicitation Number'] ?? item.solicitationNumber)
    const family = solicitationFamily(sol)
    let existing = currentWatches.find((watch) => normalized(watch.noticeId) === notice || (sol && normalized(watch.solicitationNumber) === sol))
    // A new amendment notice is only associated with an older watch when it
    // still has the same agency and a materially similar title.
    if (!existing && family) {
      existing = currentWatches.find((watch) =>
        solicitationFamily(watch.solicitationNumber) === family &&
        normalized(watch.agency) === normalized(item.Agency ?? item.agency) &&
        titleOverlap(watch.title, item.Title ?? item.title) >= 0.6
      )
    }
    const next = toWatch(item, existing)
    if (existing && normalized(existing.noticeId) !== notice && notice) {
      const fields = ['noticeId', 'solicitationNumber']
      next.change = {
        fields,
        summary: 'SAM published a related amendment or reissued notice.',
        changedAt: new Date().toISOString(),
        uiLink: clean(item['SAM.gov URL'] ?? item.samLink),
      }
    }
    // A page refresh or the app-only workbook sync must not consume a KV
    // write for every unchanged watch. Preserve the existing snapshot and
    // check state unless the source record actually changed.
    if (!existing || !sameWatchSource(existing, next)) {
      next.updatedAt = new Date().toISOString()
      await writeWatch(env, next)
      synchronized++
    } else {
      unchanged++
    }
  }
  return json({ ok: true, synchronized, unchanged })
}

export async function runSAMMonitorCheck(env, cursor = 0, { scheduled = false } = {}) {
  if (!env.SAM_API_KEY) return json({ error: 'SAM_API_KEY not configured' }, 503)
  cursor = Math.max(0, Number(cursor) || 0)
  const watches = await listWatches(env)
  // A watch can be removed between scheduled batches. Restarting the cycle
  // prevents an old cursor from stranding newly added watches past the end.
  if (cursor >= watches.length) cursor = 0
  const batchSize = scheduled ? SCHEDULED_CHECK_BATCH_SIZE : CHECK_BATCH_SIZE
  const batch = watches.slice(cursor, cursor + batchSize)
  if (!batch.length) {
    return { ok: true, status: 'success', total: watches.length, checked: watches.length, nextCursor: null, errors: [], skipped: true }
  }
  console.info(JSON.stringify({ event: 'sam_monitor_started', cursor, batchSize: batch.length, total: watches.length }))
  const errors = []
  let checked = 0
  for (const watch of batch) {
    try {
      const record = await findCurrentRecord(env, watch)
      watch.lastCheckedAt = new Date().toISOString()
      if (record) {
        const nextSnapshot = snapshot(record)
        const sourceDate = nextSnapshot.modifiedDate || nextSnapshot.postedDate
        const added = Date.parse(watch.dateAdded || '')
        const changedAfterAdded = Number.isFinite(added) && Date.parse(sourceDate || '') > added
        if (watch.snapshot) {
          const fields = differences(watch.snapshot, nextSnapshot)
          if (fields.length) {
            watch.change = {
              fields,
              summary: `SAM updated ${fields.map((field) => LABELS[field]).join(', ')}.`,
              changedAt: watch.lastCheckedAt,
              uiLink: nextSnapshot.uiLink,
            }
          } else if (changedAfterAdded && (!watch.change?.reviewedAt || watch.change.changedAt !== sourceDate)) {
            watch.change = {
              fields: ['samUpdate'],
              summary: 'SAM reports this notice was updated after it was added to the pipeline.',
              changedAt: sourceDate,
              uiLink: nextSnapshot.uiLink,
            }
          }
        } else {
          // Older watches created before snapshots existed can still be
          // flagged once when SAM reports that the notice itself was posted
          // or modified after it entered this pipeline.
          if (changedAfterAdded) {
            watch.change = {
              fields: ['samUpdate'],
              summary: 'SAM reports this notice was updated after it was added to the pipeline.',
              changedAt: sourceDate,
              uiLink: nextSnapshot.uiLink,
            }
          }
        }
        watch.snapshot = nextSnapshot
      }
      await writeWatch(env, watch)
      checked++
    } catch (error) {
      console.warn(JSON.stringify({ event: 'sam_monitor_opportunity_failed', rowIndex: watch.rowIndex, message: error.message }))
      errors.push({ rowIndex: watch.rowIndex, message: error.message })
    }
  }
  const nextCursor = cursor + batch.length
  const completed = nextCursor >= watches.length
  const run = { status: completed ? 'success' : 'partial', checkedAt: new Date().toISOString(), total: watches.length, checked: nextCursor, nextCursor: completed ? null : nextCursor, errors }
  // Persist one completed status only when work was performed. The old
  // running/success pair was two writes every hour even with no useful work.
  await env.CACHE.put(RUN_KEY, JSON.stringify(run))
  console.info(JSON.stringify({ event: 'sam_monitor_completed', status: run.status, checked: run.checked, total: run.total, errors: errors.length }))
  return { ok: true, ...run }
}

async function check(req, env) {
  const body = await req.json().catch(() => ({}))
  const result = await runSAMMonitorCheck(env, body.cursor)
  if (result instanceof Response) return result
  return json(result)
}

export async function handleSAMMonitor(req, env) {
  const path = new URL(req.url).pathname
  if (path === '/sam/changes/sync' && req.method === 'POST') return sync(req, env)
  if (path === '/sam/changes/check' && req.method === 'POST') return check(req, env)
  if (path === '/sam/changes/status' && req.method === 'GET') {
    const [watches, run] = await Promise.all([listWatches(env), env.CACHE.get(RUN_KEY, 'json')])
    return json({ watches: watches.map(publicWatch), run: run || null })
  }
  if (path === '/sam/changes/review' && req.method === 'POST') {
    const body = await req.json()
    let watch = await readWatch(env, watchKey(body || {}))
    if (!watch) {
      const notice = normalized(body?.['Notice ID'] ?? body?.noticeId)
      const solicitation = normalized(body?.['Solicitation Number'] ?? body?.solicitationNumber)
      watch = (await listWatches(env)).find((item) => normalized(item.noticeId) === notice || (solicitation && normalized(item.solicitationNumber) === solicitation))
    }
    if (!watch) return json({ error: 'Monitor record not found' }, 404)
    if (watch.change) watch.change.reviewedAt = new Date().toISOString()
    await writeWatch(env, watch)
    return json({ ok: true, watch: publicWatch(watch) })
  }
  return json({ error: 'Not found' }, 404)
}
