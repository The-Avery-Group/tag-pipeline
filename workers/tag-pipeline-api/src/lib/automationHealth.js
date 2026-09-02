const DEFAULT_TTL = 60 * 60 * 24 * 180

function timestampFor(run = {}) {
  return run.completedAt || run.checkedAt || run.timestamp || run.startedAt || new Date().toISOString()
}

function failureFor(run = {}) {
  return run.status === 'error' || (run.ok === false && !run.skipped)
}

function successFor(run = {}) {
  return ['success', 'ready'].includes(run.status) || run.ok === true
}

function messageFor(run = {}) {
  return String(run.error || run.message || '').trim() || null
}

// Keep the most recent good and failed outcomes inside the job's existing
// status record. This adds no second KV write for a completed automation.
export function enrichAutomationRun(previous, next) {
  const health = { ...(previous?.health || {}) }
  const attemptedAt = timestampFor(next)

  health.lastAttemptAt = attemptedAt
  if (failureFor(next)) {
    health.lastFailureAt = attemptedAt
    health.lastFailureMessage = messageFor(next)
  } else if (successFor(next)) {
    health.lastSuccessAt = attemptedAt
    health.lastSuccessMessage = null
  }

  return { ...next, health }
}

export async function putAutomationRun(env, key, next, { expirationTtl = DEFAULT_TTL } = {}) {
  if (!env.CACHE) return next
  const previous = await env.CACHE.get(key, 'json')
  const record = enrichAutomationRun(previous, next)
  await env.CACHE.put(key, JSON.stringify(record), { expirationTtl })
  return record
}

function statusFor(run, configured) {
  if (!configured) return 'not_configured'
  if (!run) return 'not_run'
  if (run.status === 'not_configured') return 'not_configured'
  if (run.status === 'pending') return 'not_run'
  if (failureFor(run)) return 'error'
  if (run.status === 'partial') return 'partial'
  if (run.status === 'running') return 'running'
  return 'success'
}

function healthEntry({ id, label, schedule, run, configured = true, unavailableMessage }) {
  const status = statusFor(run, configured)
  const history = run?.health || {}
  const currentAt = run ? timestampFor(run) : null
  const currentError = failureFor(run) ? messageFor(run) : null

  return {
    id,
    label,
    schedule,
    status,
    lastAttemptAt: history.lastAttemptAt || currentAt,
    lastSuccessAt: history.lastSuccessAt || (status === 'success' || status === 'partial' ? currentAt : null),
    lastFailureAt: history.lastFailureAt || (status === 'error' ? currentAt : null),
    lastFailureMessage: history.lastFailureMessage || currentError,
    message: unavailableMessage || currentError || null,
  }
}

export async function getAutomationHealth(env) {
  const [samPull, samChanges, rfiFollowUps, notifications, capabilities] = await Promise.all([
    env.CACHE?.get('sam_run_log', 'json'),
    env.CACHE?.get('sam_monitor_run', 'json'),
    env.CACHE?.get('rfi_followup_monitor_run', 'json'),
    env.CACHE?.get('scheduled_notifications:last_run', 'json'),
    env.CACHE?.get('capabilities:status', 'json'),
  ])

  const graphConfigured = Boolean(env.MS_TENANT_ID && env.MS_CLIENT_ID && env.MS_CLIENT_SECRET && env.WORKBOOK_ID)
  return [
    healthEntry({
      id: 'sam_pull', label: 'SAM.gov opportunity pull', schedule: 'Weekdays at 1 AM, 7 AM, 1 PM, and 7 PM WAT', run: samPull,
      configured: Boolean(env.SAM_API_KEY && graphConfigured),
      unavailableMessage: env.SAM_API_KEY && graphConfigured ? null : 'SAM.gov or Microsoft 365 application access is not configured.',
    }),
    healthEntry({
      id: 'sam_changes', label: 'SAM.gov update checks', schedule: 'Four times on weekdays; twice daily on weekends', run: samChanges,
      configured: Boolean(env.SAM_API_KEY),
      unavailableMessage: env.SAM_API_KEY ? null : 'SAM API access is not configured.',
    }),
    healthEntry({
      id: 'rfi_followups', label: 'RFI follow-on checks', schedule: 'Monday, Wednesday, Friday at 1 PM WAT', run: rfiFollowUps,
      configured: Boolean(env.SAM_API_KEY && env.CACHE),
      unavailableMessage: env.SAM_API_KEY && env.CACHE ? null : 'SAM.gov access or background storage is not configured.',
    }),
    healthEntry({
      id: 'notifications', label: 'Teams reminders', schedule: 'Daily at 2:01 PM WAT', run: notifications,
      configured: Boolean(env.TEAMS_WEBHOOK_URL && graphConfigured),
      unavailableMessage: env.TEAMS_WEBHOOK_URL && graphConfigured ? null : 'Teams or Microsoft 365 application access is not configured.',
    }),
    healthEntry({
      id: 'capabilities', label: 'Capabilities document', schedule: 'Daily source check', run: capabilities,
      configured: Boolean(env.CAPABILITIES_FILE_ID && graphConfigured),
      unavailableMessage: env.CAPABILITIES_FILE_ID && graphConfigured ? null : 'Capabilities document or Microsoft 365 application access is not configured.',
    }),
  ]
}
