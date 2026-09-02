const DEFAULT_TTL = 60 * 60 * 24 * 180
const D1_STATE_CHUNK_CHARACTERS = 700_000
const CHUNK_MARKER = '__crmRuntimeStateChunks'

function expiryFromTtl(expirationTtl) {
  const seconds = Number(expirationTtl || 0)
  return seconds > 0 ? new Date(Date.now() + seconds * 1000).toISOString() : null
}

function stateCategory(key, fallback = 'runtime') {
  const value = String(key || '')
  return String(fallback || value.split(':')[0] || 'runtime').slice(0, 80)
}

async function d1StateGet(env, key) {
  if (!env.EBUY_DB) return { available: false, value: null }
  try {
    const row = await env.EBUY_DB.prepare(`SELECT payload_json FROM crm_runtime_state
      WHERE state_key = ? AND (expires_at IS NULL OR expires_at > ?)`)
      .bind(String(key), new Date().toISOString()).first()
    if (!row) return { available: true, value: null }
    const value = JSON.parse(row.payload_json)
    if (!value?.[CHUNK_MARKER]) return { available: true, value }
    const result = await env.EBUY_DB.prepare(`SELECT payload_json FROM crm_runtime_state
      WHERE state_key >= ? AND state_key < ? ORDER BY state_key`)
      .bind(`${String(key)}::chunk::`, `${String(key)}::chunk::\uffff`).all()
    const chunks = result.results || []
    if (chunks.length !== Number(value[CHUNK_MARKER])) return { available: true, value: null }
    return { available: true, value: JSON.parse(chunks.map((chunk) => chunk.payload_json).join('')) }
  } catch (error) {
    if (!/no such table/i.test(String(error?.message || ''))) throw error
    return { available: false, value: null }
  }
}

export async function getRuntimeState(env, key, { legacyKv = true } = {}) {
  const stored = await d1StateGet(env, key)
  if (stored.value !== null || !legacyKv || !env.CACHE) return stored.value
  const legacy = await env.CACHE.get(String(key), 'json').catch(() => null)
  if (legacy !== null && stored.available) {
    await putRuntimeState(env, key, legacy, { category: 'legacy-migrated' }).catch(() => {})
  }
  return legacy
}

export async function putRuntimeState(env, key, value, { category, expirationTtl } = {}) {
  const now = new Date().toISOString()
  if (env.EBUY_DB) {
    try {
      const stateKey = String(key)
      const stateCategoryValue = stateCategory(key, category)
      const expiresAt = expiryFromTtl(expirationTtl)
      const serialized = JSON.stringify(value)
      const chunks = serialized.length > D1_STATE_CHUNK_CHARACTERS
        ? Array.from({ length: Math.ceil(serialized.length / D1_STATE_CHUNK_CHARACTERS) }, (_, index) => (
          serialized.slice(index * D1_STATE_CHUNK_CHARACTERS, (index + 1) * D1_STATE_CHUNK_CHARACTERS)
        ))
        : []
      const statements = chunks.map((chunk, index) => env.EBUY_DB.prepare(`INSERT INTO crm_runtime_state
        (state_key, category, payload_json, expires_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(state_key) DO UPDATE SET category = excluded.category,
          payload_json = excluded.payload_json, expires_at = excluded.expires_at,
          updated_at = excluded.updated_at
        WHERE crm_runtime_state.payload_json <> excluded.payload_json
          OR crm_runtime_state.category <> excluded.category
          OR (crm_runtime_state.expires_at IS NULL) <> (excluded.expires_at IS NULL)
          OR crm_runtime_state.expires_at <= excluded.updated_at`)
        .bind(`${stateKey}::chunk::${String(index).padStart(5, '0')}`, `${stateCategoryValue}-chunk`, chunk, expiresAt, now, now))
      statements.push(env.EBUY_DB.prepare(`INSERT INTO crm_runtime_state
        (state_key, category, payload_json, expires_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(state_key) DO UPDATE SET category = excluded.category,
          payload_json = excluded.payload_json, expires_at = excluded.expires_at,
          updated_at = excluded.updated_at
        WHERE crm_runtime_state.payload_json <> excluded.payload_json
          OR crm_runtime_state.category <> excluded.category
          OR (crm_runtime_state.expires_at IS NULL) <> (excluded.expires_at IS NULL)
          OR crm_runtime_state.expires_at <= excluded.updated_at`)
        .bind(stateKey, stateCategoryValue, chunks.length ? JSON.stringify({ [CHUNK_MARKER]: chunks.length }) : serialized, expiresAt, now, now))
      await env.EBUY_DB.batch(statements)
      await env.EBUY_DB.prepare(`DELETE FROM crm_runtime_state
        WHERE state_key >= ? AND state_key < ? AND state_key >= ?`)
        .bind(`${stateKey}::chunk::`, `${stateKey}::chunk::\uffff`, `${stateKey}::chunk::${String(chunks.length).padStart(5, '0')}`).run()
      return value
    } catch (error) {
      if (!/no such table/i.test(String(error?.message || ''))) throw error
    }
  }
  // Compatibility for local tests and the short deployment window before the
  // migration is applied. Production has EBUY_DB and therefore does not write KV.
  if (env.CACHE) await env.CACHE.put(String(key), JSON.stringify(value), expirationTtl ? { expirationTtl } : undefined)
  return value
}

export async function deleteRuntimeState(env, key) {
  if (env.EBUY_DB) {
    try {
      const stateKey = String(key)
      await env.EBUY_DB.prepare(`DELETE FROM crm_runtime_state
        WHERE state_key = ? OR (state_key >= ? AND state_key < ?)`)
        .bind(stateKey, `${stateKey}::chunk::`, `${stateKey}::chunk::\uffff`).run()
      return
    } catch (error) {
      if (!/no such table/i.test(String(error?.message || ''))) throw error
    }
  }
  if (env.CACHE) await env.CACHE.delete(String(key))
}

export async function listRuntimeState(env, prefix, { limit = 1000 } = {}) {
  if (env.EBUY_DB) {
    try {
      const start = String(prefix)
      const migrationMarkerKey = `__legacy_prefix_migrated:${start}`
      const result = await env.EBUY_DB.prepare(`SELECT state_key, payload_json FROM crm_runtime_state
        WHERE state_key >= ? AND state_key < ? AND (expires_at IS NULL OR expires_at > ?)
          AND instr(state_key, '::chunk::') = 0
        ORDER BY state_key LIMIT ?`)
        .bind(start, `${start}\uffff`, new Date().toISOString(), Math.min(1000, Number(limit) || 1000)).all()
      const current = (result.results || []).map((row) => {
        try { return { key: row.state_key, value: JSON.parse(row.payload_json) } } catch { return null }
      }).filter(Boolean)
      const marker = await d1StateGet(env, migrationMarkerKey)
      if (marker.value === true || !env.CACHE) return current

      // Import each legacy watch collection once. The marker prevents a later
      // intentional D1 deletion from resurrecting an obsolete KV record.
      const listed = await env.CACHE.list({ prefix: start, limit: Math.min(1000, Number(limit) || 1000) })
      const currentKeys = new Set(current.map((item) => item.key))
      const legacy = (await Promise.all(listed.keys
        .filter(({ name }) => !currentKeys.has(name))
        .map(async ({ name }) => ({ key: name, value: await env.CACHE.get(name, 'json') })))).filter((item) => item.value !== null)
      const migratedAt = new Date().toISOString()
      const migrationStatements = [...legacy.map((item) => env.EBUY_DB.prepare(`INSERT INTO crm_runtime_state
        (state_key, category, payload_json, expires_at, created_at, updated_at)
        VALUES (?, 'legacy-migrated', ?, NULL, ?, ?)
        ON CONFLICT(state_key) DO NOTHING`)
        .bind(item.key, JSON.stringify(item.value), migratedAt, migratedAt)), env.EBUY_DB.prepare(`INSERT INTO crm_runtime_state
        (state_key, category, payload_json, expires_at, created_at, updated_at)
        VALUES (?, 'migration-marker', 'true', NULL, ?, ?)
        ON CONFLICT(state_key) DO UPDATE SET payload_json = 'true', updated_at = excluded.updated_at`)
        .bind(migrationMarkerKey, migratedAt, migratedAt)]
      await env.EBUY_DB.batch(migrationStatements)
      return [...current, ...legacy]
    } catch (error) {
      if (!/no such table/i.test(String(error?.message || ''))) throw error
    }
  }
  if (!env.CACHE) return []
  const listed = await env.CACHE.list({ prefix: String(prefix), limit: Math.min(1000, Number(limit) || 1000) })
  return (await Promise.all(listed.keys.map(async ({ name }) => ({ key: name, value: await env.CACHE.get(name, 'json') })))).filter((item) => item.value !== null)
}

export async function purgeRuntimeState(db, { limit = 500 } = {}) {
  if (!db) return { deleted: 0 }
  try {
    const result = await db.prepare(`DELETE FROM crm_runtime_state WHERE state_key IN (
      SELECT state_key FROM crm_runtime_state WHERE expires_at IS NOT NULL AND expires_at <= ?
      ORDER BY expires_at LIMIT ?
    )`).bind(new Date().toISOString(), Math.min(500, Math.max(1, Number(limit) || 500))).run()
    return { deleted: Number(result.meta?.changes || result.changes || 0) }
  } catch (error) {
    if (/no such table/i.test(String(error?.message || ''))) return { deleted: 0 }
    throw error
  }
}

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
  const previous = await getRuntimeState(env, key)
  const record = enrichAutomationRun(previous, next)
  await putRuntimeState(env, key, record, { category: 'automation-run', expirationTtl })
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
    getRuntimeState(env, 'sam_run_log'),
    getRuntimeState(env, 'sam_monitor_run'),
    getRuntimeState(env, 'rfi_followup_monitor_run'),
    getRuntimeState(env, 'scheduled_notifications:last_run'),
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
      id: 'rfi_followups', label: 'RFI follow-on checks', schedule: 'Four times each weekday', run: rfiFollowUps,
      configured: Boolean(env.SAM_API_KEY && (env.EBUY_DB || env.CACHE)),
      unavailableMessage: env.SAM_API_KEY && (env.EBUY_DB || env.CACHE) ? null : 'SAM.gov access or background storage is not configured.',
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
