import { putAutomationRun } from '../lib/automationHealth.js'
import {
  acknowledgeOpportunityAlert,
  alertFingerprint,
  alertStorageReady,
  listOpportunityAlerts,
  upsertOpportunityAlert,
} from '../lib/opportunityAlerts.js'
import {
  claimWorkspaceRun,
  findWorkspaceBySource,
  updateWorkspace,
} from '../lib/opportunityWorkspaceRepository.js'

/**
 * Lightweight, checkpointed monitor for opportunities already saved in
 * NewOpportunitiesTable. It deliberately does not use Graph or the pull
 * handler, so checking SAM changes cannot make opportunity pulls slower.
 */

const SAM_BASE = 'https://api.sam.gov/opportunities/v2/search'
const WATCH_PREFIX = 'sam_monitor_watch:'
const RUN_KEY = 'sam_monitor_run'
const STATUS_SNAPSHOT_KEY = 'sam_monitor_status_snapshot_v1'
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
function normalizedRevision(value) {
  const text = clean(value)
  if (!text) return ''
  const timestamp = new Date(text).getTime()
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : text
}

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
  const incomingNoticeId = clean(item.noticeId ?? item['Notice ID'])
  const incomingSolicitationNumber = clean(item.solicitationNumber ?? item['Solicitation Number'])
  return {
    ...(existing || {}),
    // Keep the original KV key when an amendment is associated with an
    // existing watch. This prevents the old watch from becoming an orphan.
    key: existing?.key || watchKey(item),
    opportunityKey: existing?.opportunityKey || existing?.noticeId || incomingNoticeId || incomingSolicitationNumber,
    rowIndex: Number(item.rowIndex ?? item._rowIndex),
    noticeId: existing?.noticeId || incomingNoticeId,
    solicitationNumber: existing?.solicitationNumber || incomingSolicitationNumber,
    title: clean(item.title ?? item.Title),
    department: clean(item.department ?? item.Department),
    agency: clean(item.agency ?? item.Agency),
    status: clean(item.status ?? item.Status).toLowerCase(),
    dateAdded: clean(item.dateAdded ?? item['Date Added']),
  }
}

export function preserveSAMChangeReview(previous, candidate, nextSnapshot) {
  if (!candidate) return candidate
  const fingerprint = alertFingerprint({
    sourceModifiedAt: normalizedRevision(candidate.sourceModifiedAt),
    fields: candidate.fields,
    snapshot: nextSnapshot,
  })
  const sameFields = JSON.stringify([...(previous?.fields || [])].sort()) === JSON.stringify([...(candidate.fields || [])].sort())
  const sameRevision = previous?.fingerprint === fingerprint ||
    previous?.reviewedFingerprint === fingerprint ||
    (normalizedRevision(previous?.sourceModifiedAt) === normalizedRevision(candidate.sourceModifiedAt) && sameFields)
  return {
    ...candidate,
    fingerprint,
    reviewedAt: sameRevision ? previous?.reviewedAt || null : null,
    reviewedFingerprint: sameRevision
      ? previous?.reviewedFingerprint || (previous?.reviewedAt ? fingerprint : null)
      : null,
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

async function writeStatusSnapshot(env, watches) {
  return persistStatusSnapshot(env, {
    watches: watches.map(publicWatch),
    updatedAt: new Date().toISOString(),
  })
}

async function readStatusSnapshot(env) {
  try {
    const value = await env.CACHE.get(STATUS_SNAPSHOT_KEY)
    if (!value) return null
    const snapshot = JSON.parse(value)
    return Array.isArray(snapshot?.watches) ? snapshot : null
  } catch (error) {
    console.warn(JSON.stringify({
      event: 'sam_monitor_status_snapshot_read_failed',
      message: error.message,
    }))
    return null
  }
}

async function persistStatusSnapshot(env, snapshot) {
  try {
    await env.CACHE.put(STATUS_SNAPSHOT_KEY, JSON.stringify(snapshot))
    return true
  } catch (error) {
    console.warn(JSON.stringify({
      event: 'sam_monitor_status_snapshot_write_failed',
      message: error.message,
    }))
    return false
  }
}

async function readRunStatus(env) {
  try {
    return await env.CACHE.get(RUN_KEY, 'json')
  } catch (error) {
    console.warn(JSON.stringify({
      event: 'sam_monitor_run_status_read_failed',
      message: error.message,
    }))
    return null
  }
}

async function updateStatusSnapshotEntry(env, watch) {
  const snapshot = await readStatusSnapshot(env)
  if (!snapshot) return
  const next = publicWatch(watch)
  const index = snapshot.watches.findIndex((item) =>
    Number(item.rowIndex) === Number(next.rowIndex) ||
    (next.noticeId && normalized(item.noticeId) === normalized(next.noticeId)) ||
    (next.solicitationNumber && normalized(item.solicitationNumber) === normalized(next.solicitationNumber))
  )
  if (index >= 0) snapshot.watches[index] = next
  else snapshot.watches.push(next)
  snapshot.updatedAt = new Date().toISOString()
  await persistStatusSnapshot(env, snapshot)
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
  const fields = watch.change?.fields || []
  const changeDay = clean(watch.change?.changedAt).slice(0, 10)
  const addedDay = clean(watch.dateAdded).slice(0, 10)
  const invalidInitialBadge = fields.length === 1 &&
    fields[0] === 'samUpdate' &&
    /^\d{4}-\d{2}-\d{2}$/.test(changeDay) &&
    /^\d{4}-\d{2}-\d{2}$/.test(addedDay) &&
    changeDay <= addedDay
  const visibleChange = invalidInitialBadge ? null : watch.change
  return {
    opportunityKey: watch.opportunityKey || watch.noticeId || watch.solicitationNumber,
    rowIndex: watch.rowIndex,
    title: watch.title || watch.snapshot?.title || '',
    noticeId: watch.noticeId,
    solicitationNumber: watch.solicitationNumber,
    changed: Boolean(visibleChange && !visibleChange.reviewedAt),
    change: visibleChange ? {
      fields: visibleChange.fields || [],
      summary: visibleChange.summary || '',
      changedAt: visibleChange.changedAt,
      reviewedAt: visibleChange.reviewedAt || null,
      fingerprint: visibleChange.fingerprint || '',
      uiLink: visibleChange.uiLink || watch.snapshot?.uiLink || '',
    } : null,
    lastCheckedAt: watch.lastCheckedAt || null,
    latest: watch.snapshot || null,
  }
}

async function overlayDurableReview(env, watches) {
  if (!env.EBUY_DB || !(await alertStorageReady(env.EBUY_DB))) return watches
  const alerts = await listOpportunityAlerts(env.EBUY_DB)
  const byKey = new Map(alerts.filter((alert) => alert.type === 'sam_change').map((alert) => [normalized(alert.opportunityKey), alert]))
  return watches.map((watch) => {
    const alert = byKey.get(normalized(watch.opportunityKey)) || byKey.get(normalized(watch.noticeId)) || byKey.get(normalized(watch.solicitationNumber))
    if (!alert || !watch.change) return watch
    return {
      ...watch,
      changed: alert.badgeVisible,
      change: { ...watch.change, reviewedAt: alert.acknowledgedAt || watch.change.reviewedAt || null },
    }
  })
}

async function recordDurableSAMChange(env, watch) {
  if (!watch.change || !env.EBUY_DB || !(await alertStorageReady(env.EBUY_DB))) return null
  const fingerprint = watch.change.fingerprint || alertFingerprint({
    sourceModifiedAt: normalizedRevision(watch.change.sourceModifiedAt),
    fields: watch.change.fields,
    snapshot: watch.snapshot,
  })
  watch.change.fingerprint = fingerprint
  const opportunityKey = watch.opportunityKey || watch.noticeId || watch.solicitationNumber
  const identityDetails = {
    opportunityTitle: watch.title || watch.snapshot?.title || '',
    noticeId: watch.noticeId || watch.snapshot?.noticeId || '',
    solicitationNumber: watch.solicitationNumber || watch.snapshot?.solicitationNumber || '',
    discoveryRowIndex: watch.rowIndex ?? null,
  }
  await upsertOpportunityAlert(env.EBUY_DB, {
    opportunityKey,
    type: 'sam_change',
    fingerprint,
    summary: watch.change.summary,
    details: { ...identityDetails, fields: watch.change.fields, sourceModifiedAt: watch.change.sourceModifiedAt, uiLink: watch.change.uiLink },
  })
  if (watch.change.fields?.includes('resourceLinks')) {
    await upsertOpportunityAlert(env.EBUY_DB, {
      opportunityKey,
      type: 'sam_files',
      fingerprint: alertFingerprint({ sourceRevision: watch.change.sourceModifiedAt, current: watch.snapshot?.resourceLinks || [] }),
      summary: 'SAM.gov attachment list changed',
      details: { ...identityDetails, sourceRevision: watch.change.sourceModifiedAt, resourceLinks: watch.snapshot?.resourceLinks || [] },
    })
  }
  return fingerprint
}

async function startAttachmentRefresh(env, watch, revision) {
  if (!env.EBUY_DB || !env.OPPORTUNITY_WORKSPACE_WORKFLOW?.createBatch || !revision || watch.attachmentSyncRevision === revision) return false
  const workspace = await findWorkspaceBySource(env.EBUY_DB, {
    noticeId: watch.noticeId,
    solicitationNumber: watch.solicitationNumber,
  })
  if (!workspace?.rootFolderId) return false
  const instanceId = `opportunity-workspace-sync-${crypto.randomUUID()}`
  const claimed = await claimWorkspaceRun(env.EBUY_DB, workspace.opportunityKey, instanceId, { force: true })
  if (!claimed) return false
  try {
    await env.OPPORTUNITY_WORKSPACE_WORKFLOW.createBatch([{
      id: instanceId,
      params: {
        opportunityKey: workspace.opportunityKey,
        syncAttachments: true,
        sourceRevision: revision,
      },
      retention: { successRetention: '7 days', errorRetention: '14 days' },
    }])
    watch.attachmentSyncRevision = revision
    return true
  } catch (error) {
    await updateWorkspace(env.EBUY_DB, workspace.opportunityKey, {
      status: 'ready',
      progressPhase: 'Workspace ready; attachment refresh could not start',
      errorMessage: error.message,
    }).catch(() => {})
    throw error
  }
}

async function sync(req, env) {
  const body = await req.json()
  const items = Array.isArray(body?.opportunities) ? body.opportunities : []
  const dismissedRowIndices = new Set((Array.isArray(body?.dismissedRowIndices) ? body.dismissedRowIndices : [])
    .map((rowIndex) => Number(rowIndex)).filter(Number.isFinite))
  const eligible = items.filter((item) => ['new', 'tracked', 'added_to_pipeline'].includes(clean(item.Status ?? item.status).toLowerCase()))
  if (eligible.length > 200) return json({ error: 'Too many opportunities to monitor at once' }, 400)

  const currentWatches = await listWatches(env)
  // A record can be added or tracked first and dismissed later. Explicitly
  // delete its existing watch so it cannot be checked again by an autonomous
  // Worker batch or retain an outdated SAM-updated badge.
  const removed = currentWatches.filter((watch) => dismissedRowIndices.has(Number(watch.rowIndex)))
  await Promise.all(removed.map((watch) => env.CACHE.delete(watch.key)))
  const activeWatches = currentWatches.filter((watch) => !dismissedRowIndices.has(Number(watch.rowIndex)))
  let synchronized = 0
  let unchanged = 0
  for (const item of eligible) {
    const notice = normalized(item['Notice ID'] ?? item.noticeId)
    const sol = normalized(item['Solicitation Number'] ?? item.solicitationNumber)
    const family = solicitationFamily(sol)
    let existing = activeWatches.find((watch) => normalized(watch.noticeId) === notice || (sol && normalized(watch.solicitationNumber) === sol))
    // A new amendment notice is only associated with an older watch when it
    // still has the same agency and a materially similar title.
    if (!existing && family) {
      existing = activeWatches.find((watch) =>
        solicitationFamily(watch.solicitationNumber) === family &&
        normalized(watch.agency) === normalized(item.Agency ?? item.agency) &&
        titleOverlap(watch.title, item.Title ?? item.title) >= 0.6
      )
    }
    const relatedNotice = Boolean(existing && normalized(existing.noticeId) !== notice && notice)
    const next = relatedNotice ? { ...existing } : toWatch(item, existing)
    if (relatedNotice) {
      const fields = ['noticeId', 'solicitationNumber']
      next.change = preserveSAMChangeReview(existing.change, {
        fields,
        summary: 'SAM published a related amendment or reissued notice.',
        changedAt: clean(item['Posted Date'] ?? item.postedDate) || new Date().toISOString(),
        sourceModifiedAt: clean(item['Modified Date'] ?? item.modifiedDate ?? item['Posted Date'] ?? item.postedDate) || notice,
        uiLink: clean(item['SAM.gov URL'] ?? item.samLink),
      }, existing.snapshot)
    }
    // A page refresh or the app-only workbook sync must not consume a KV
    // write for every unchanged watch. Preserve the existing snapshot and
    // check state unless the source record actually changed.
    if (relatedNotice || !existing || !sameWatchSource(existing, next)) {
      next.updatedAt = new Date().toISOString()
      await writeWatch(env, next)
      const existingIndex = activeWatches.findIndex((watch) => watch.key === next.key)
      if (existingIndex >= 0) activeWatches[existingIndex] = next
      else activeWatches.push(next)
      synchronized++
    } else {
      unchanged++
    }
  }
  if (synchronized || removed.length) await writeStatusSnapshot(env, activeWatches)
  return json({ ok: true, synchronized, unchanged, removed: removed.length })
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
        // Date Added has no time component. Compare calendar days so a notice
        // pulled later on its first day is not immediately labelled updated.
        const sourceDay = clean(sourceDate).slice(0, 10)
        const addedDay = clean(watch.dateAdded).slice(0, 10)
        const changedAfterAdded = /^\d{4}-\d{2}-\d{2}$/.test(sourceDay) &&
          /^\d{4}-\d{2}-\d{2}$/.test(addedDay) &&
          sourceDay > addedDay
        if (
          watch.change?.fields?.length === 1 &&
          watch.change.fields[0] === 'samUpdate' &&
          !changedAfterAdded
        ) {
          delete watch.change
        }
        if (watch.snapshot) {
          const fields = differences(watch.snapshot, nextSnapshot)
          if (fields.length) {
            watch.change = preserveSAMChangeReview(watch.change, {
              fields,
              summary: `SAM.gov updated ${fields.map((field) => LABELS[field]).join(', ')}.`,
              changedAt: watch.lastCheckedAt,
              // Keep the SAM source revision that produced this change. A
              // later check may find no field differences because the saved
              // snapshot is now current; without this marker that check used
              // to replace an acknowledged field-level change with a fresh,
              // unreviewed generic badge.
              sourceModifiedAt: sourceDate,
              uiLink: nextSnapshot.uiLink,
            }, nextSnapshot)
          } else if (watch.change?.reviewedAt && !watch.change.sourceModifiedAt) {
            // Upgrade older reviewed records in place. Treat the current SAM
            // revision as the revision the user reviewed instead of raising
            // the same update once more after deployment.
            watch.change.sourceModifiedAt = sourceDate
          } else if (changedAfterAdded && (!watch.change || watch.change.sourceModifiedAt !== sourceDate)) {
            watch.change = preserveSAMChangeReview(watch.change, {
              fields: ['samUpdate'],
              summary: 'SAM reports this notice was updated after it was added to the pipeline.',
              changedAt: sourceDate,
              sourceModifiedAt: sourceDate,
              uiLink: nextSnapshot.uiLink,
            }, nextSnapshot)
          }
        } else {
          // Older watches created before snapshots existed can still be
          // flagged once when SAM reports that the notice itself was posted
          // or modified after it entered this pipeline.
          if (changedAfterAdded) {
            watch.change = preserveSAMChangeReview(watch.change, {
              fields: ['samUpdate'],
              summary: 'SAM reports this notice was updated after it was added to the pipeline.',
              changedAt: sourceDate,
              sourceModifiedAt: sourceDate,
              uiLink: nextSnapshot.uiLink,
            }, nextSnapshot)
          }
        }
        watch.snapshot = nextSnapshot
        if (watch.change) await recordDurableSAMChange(env, watch)
        if (watch.change?.sourceModifiedAt && watch.attachmentSyncRevision !== watch.change.sourceModifiedAt) {
          await startAttachmentRefresh(env, watch, watch.change.sourceModifiedAt).catch((error) => {
            console.warn(JSON.stringify({ event: 'sam_attachment_refresh_start_failed', noticeId: watch.noticeId, message: error.message }))
          })
        }
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
  await Promise.all([
    putAutomationRun(env, RUN_KEY, run),
    writeStatusSnapshot(env, watches),
  ])
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
  const url = new URL(req.url)
  const path = url.pathname
  if (path === '/sam/changes/sync' && req.method === 'POST') return sync(req, env)
  if (path === '/sam/changes/check' && req.method === 'POST') return check(req, env)
  if (path === '/sam/changes/status' && req.method === 'GET') {
    const noticeId = clean(url.searchParams.get('noticeId'))
    const solicitationNumber = clean(url.searchParams.get('solicitationNumber'))
    if (noticeId || solicitationNumber) {
      const watch = await readWatch(env, watchKey({ noticeId, solicitationNumber }))
      const run = await readRunStatus(env)
      return json({ watches: watch ? await overlayDurableReview(env, [publicWatch(watch)]) : [], run: run || null })
    }
    const [snapshot, run] = await Promise.all([
      readStatusSnapshot(env),
      readRunStatus(env),
    ])
    if (snapshot) return json({ watches: await overlayDurableReview(env, snapshot.watches), run: run || null })
    try {
      const watches = await listWatches(env)
      await writeStatusSnapshot(env, watches)
      return json({ watches: await overlayDurableReview(env, watches.map(publicWatch)), run: run || null })
    } catch (error) {
      console.warn(JSON.stringify({
        event: 'sam_monitor_status_fallback_failed',
        message: error.message,
      }))
      return json({ watches: [], run: run || null, temporarilyUnavailable: true })
    }
  }
  if (path === '/sam/changes/review' && req.method === 'POST') {
    const body = await req.json()
    let watch = await readWatch(env, watchKey(body || {}))
    if (!watch) {
      const notice = normalized(body?.['Notice ID'] ?? body?.noticeId)
      const solicitation = normalized(body?.['Solicitation Number'] ?? body?.solicitationNumber)
      const rowIndex = Number(body?._rowIndex ?? body?.rowIndex)
      watch = (await listWatches(env)).find((item) =>
        (Number.isFinite(rowIndex) && Number(item.rowIndex) === rowIndex) ||
        normalized(item.noticeId) === notice ||
        (solicitation && normalized(item.solicitationNumber) === solicitation)
      )
    }
    if (!watch) return json({ error: 'Monitor record not found' }, 404)
    if (watch.change) {
      const fingerprint = watch.change.fingerprint || alertFingerprint({
        sourceModifiedAt: normalizedRevision(watch.change.sourceModifiedAt),
        fields: watch.change.fields,
        snapshot: watch.snapshot,
      })
      watch.change.fingerprint = fingerprint
      watch.change.reviewedFingerprint = fingerprint
      watch.change.reviewedAt = new Date().toISOString()
    }
    if (watch.change && env.EBUY_DB && await alertStorageReady(env.EBUY_DB)) {
      const opportunityKey = watch.opportunityKey || watch.noticeId || watch.solicitationNumber
      await acknowledgeOpportunityAlert(env.EBUY_DB, opportunityKey, 'sam_change', watch.change.fingerprint || '')
      await acknowledgeOpportunityAlert(env.EBUY_DB, opportunityKey, 'sam_files')
    }
    await writeWatch(env, watch)
    await updateStatusSnapshotEntry(env, watch)
    return json({ ok: true, watch: publicWatch(watch) })
  }
  return json({ error: 'Not found' }, 404)
}
