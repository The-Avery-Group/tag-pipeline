import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getRFIFollowUpDecisions, getRFIFollowUpOverrides, getSAMSettings } from '@/services/graphService'

const WORKER_URL = import.meta.env.VITE_API_BASE_URL

const C = {
  phase: 'TAG Opportunity Phase', outlook: 'Opportunity Outlook', contractNumber: 'Contract Number / Notice ID',
  title: 'Project Title / Description*', department: 'Department*', agency: 'Agency*',
  poc: 'Contracting Officer / Specialist (POC)*', solicitation: 'Solicitation Number', submissionDate: 'Submission Date (Response Date)*',
}

const DEFAULT_RULES = {
  monitoringEnabled: true, departmentRule: 'Exact', agencyRule: 'Exact', pocRule: 'Exact',
  titleOverlapPercent: 40, noticeTypes: 'RFP, RFQ', submissionWindowDays: 364,
  noSubmissionLookbackDays: 150, noSubmissionLookaheadDays: 150,
}

function normalized(value) { return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ') }
function yes(value, fallback = true) {
  if (value === undefined || value === null || value === '') return fallback
  return ['yes', 'true', 'enabled', '1'].includes(String(value).trim().toLowerCase())
}
function number(value, fallback, min, max) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : fallback
}

export function isRfiOpportunity(opportunity) {
  return opportunity?.[C.phase] === 'Identified' && opportunity?.[C.outlook] === 'New'
}

export function findRfiPocEmail(opportunity, contacts = []) {
  const names = String(opportunity?.[C.poc] || '').split(',').map((name) => name.trim()).filter(Boolean)
  return contacts.find((contact) => names.includes(String(contact.Name || '').trim()) && contact.Email)?.Email || ''
}

export function effectiveRfiFollowUpCriteria(opportunity, contacts, globalRules = DEFAULT_RULES, override = null) {
  const global = { ...DEFAULT_RULES, ...(globalRules || {}) }
  const usingGlobal = !override || yes(override['Use Global Criteria'], true)
  const enabled = !override ? global.monitoringEnabled : yes(override['Monitoring Enabled'], true)
  const resolveValue = (ruleKey, overrideKey, valueKey, defaultValue) => {
    if (usingGlobal) return { rule: global[ruleKey], value: defaultValue }
    const selected = String(override[overrideKey] || 'Exact')
    if (selected === 'Ignore') return { rule: 'Ignore', value: defaultValue }
    return { rule: 'Exact', value: selected === 'Override' ? String(override[valueKey] || '').trim() : defaultValue }
  }
  const department = resolveValue('departmentRule', 'Department Rule', 'Department Override', opportunity?.[C.department] || '')
  const agency = resolveValue('agencyRule', 'Agency Rule', 'Agency Override', opportunity?.[C.agency] || '')
  const poc = resolveValue('pocRule', 'POC Rule', 'POC Email Override', findRfiPocEmail(opportunity, contacts))
  const numeric = (key, low, high) => usingGlobal ? global[key] : number(override[key === 'titleOverlapPercent' ? 'Title Overlap %' : key === 'submissionWindowDays' ? 'Submission Window Days' : key === 'noSubmissionLookbackDays' ? 'No-Submission Lookback Days' : 'No-Submission Lookahead Days'], global[key], low, high)
  const noticeTypes = usingGlobal ? global.noticeTypes : String(override['Notice Types'] || global.noticeTypes)
  return {
    opportunityId: opportunity?.[C.contractNumber] || '', rowIndex: opportunity?._rowIndex,
    title: opportunity?.[C.title] || '', department: department.value, agency: agency.value, pocEmail: poc.value,
    noticeId: opportunity?.[C.contractNumber] || '', solicitationNumber: opportunity?.[C.solicitation] || '', submissionDate: opportunity?.[C.submissionDate] || '',
    rules: {
      monitoringEnabled: enabled, departmentRule: department.rule, agencyRule: agency.rule, pocRule: poc.rule,
      titleOverlapPercent: numeric('titleOverlapPercent', 1, 100), noticeTypes,
      submissionWindowDays: numeric('submissionWindowDays', 1, 364),
      noSubmissionLookbackDays: numeric('noSubmissionLookbackDays', 0, 364),
      noSubmissionLookaheadDays: numeric('noSubmissionLookaheadDays', 0, 364),
    },
  }
}

export function useRfiFollowUpMonitor(opportunities, contacts = [], { replace = false } = {}) {
  const [globalRules, setGlobalRules] = useState(DEFAULT_RULES)
  const [overrides, setOverrides] = useState([])
  const [decisions, setDecisions] = useState([])
  const [statusByOpportunity, setStatusByOpportunity] = useState({})
  const [loading, setLoading] = useState(true)
  const [checking, setChecking] = useState(false)
  const [error, setError] = useState(null)
  const fingerprint = useRef('')

  const refreshConfiguration = useCallback(async () => {
    const [settings, loadedOverrides, loadedDecisions] = await Promise.all([
      getSAMSettings(), getRFIFollowUpOverrides(), getRFIFollowUpDecisions(),
    ])
    setGlobalRules(settings.rfiFollowUp || DEFAULT_RULES)
    setOverrides(loadedOverrides)
    setDecisions(loadedDecisions)
    return { rules: settings.rfiFollowUp || DEFAULT_RULES, overrides: loadedOverrides, decisions: loadedDecisions }
  }, [])

  const buildWatches = useCallback((rules = globalRules, loadedOverrides = overrides, loadedDecisions = decisions) =>
    (opportunities || []).filter(isRfiOpportunity).map((opportunity) => {
      const id = normalized(opportunity[C.contractNumber])
      const override = loadedOverrides.find((row) => normalized(row['Opportunity ID']) === id) || null
      const watch = effectiveRfiFollowUpCriteria(opportunity, contacts, rules, override)
      return { ...watch, decisions: loadedDecisions.filter((row) => normalized(row['Opportunity ID']) === id) }
    }).filter((watch) => watch.opportunityId), [contacts, decisions, globalRules, opportunities, overrides])

  const loadStatus = useCallback(async () => {
    if (!WORKER_URL) return null
    const response = await fetch(`${WORKER_URL}/sam/follow-up-monitor/status`)
    if (!response.ok) throw new Error('Could not load RFI follow-up status')
    const data = await response.json()
    const next = {}
    ;(data.watches || []).forEach((watch) => { next[normalized(watch.opportunityId)] = watch })
    setStatusByOpportunity(next)
    return data
  }, [])

  const synchronize = useCallback(async ({ forceReplace = replace } = {}) => {
    if (!WORKER_URL) return []
    const config = await refreshConfiguration()
    const watches = buildWatches(config.rules, config.overrides, config.decisions)
    const response = await fetch(`${WORKER_URL}/sam/follow-up-monitor/sync`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ watches, replace: forceReplace }),
    })
    if (!response.ok) throw new Error('Could not synchronize RFI follow-up monitoring')
    return watches
  }, [buildWatches, refreshConfiguration, replace])

  const checkOne = useCallback(async (opportunityId) => {
    if (!WORKER_URL) throw new Error('VITE_API_BASE_URL not set')
    setChecking(true); setError(null)
    try {
      await synchronize({ forceReplace: false })
      const response = await fetch(`${WORKER_URL}/sam/follow-up-monitor/check-one`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ opportunityId }),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || 'Could not check RFI follow-ups')
      setStatusByOpportunity((previous) => ({ ...previous, [normalized(opportunityId)]: data.watch }))
      return data.watch
    } catch (err) {
      setError(err.message)
      throw err
    } finally { setChecking(false) }
  }, [synchronize])

  const markSeen = useCallback(async (opportunityId) => {
    if (!WORKER_URL) return
    const response = await fetch(`${WORKER_URL}/sam/follow-up-monitor/seen`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ opportunityId }),
    })
    const data = await response.json()
    if (!response.ok) throw new Error(data.error || 'Could not mark RFI follow-ups as seen')
    setStatusByOpportunity((previous) => ({ ...previous, [normalized(opportunityId)]: data.watch }))
    return data.watch
  }, [])

  const applyDecision = useCallback((opportunityId, candidate, decision) => {
    const id = normalized(opportunityId)
    const candidateId = normalized(candidate.noticeId || candidate.solicitationNumber)
    setStatusByOpportunity((previous) => {
      const current = previous[id]
      if (!current) return previous
      const candidates = (current.candidates || []).map((item) =>
        normalized(item.noticeId || item.solicitationNumber) === candidateId ? { ...item, decision } : item
      )
      const pendingCount = candidates.filter((item) => !item.decision).length
      return { ...previous, [id]: { ...current, candidates, pendingCount, badgeVisible: pendingCount > 0 && (!current.seenUntil || Date.parse(current.seenUntil) > Date.now()), badgeState: pendingCount === 0 ? 'none' : current.badgeState } }
    })
  }, [])

  useEffect(() => {
    let live = true
    ;(async () => {
      try { await refreshConfiguration(); await loadStatus() } catch (err) { if (live) setError(err.message) } finally { if (live) setLoading(false) }
    })()
    return () => { live = false }
  }, [loadStatus, refreshConfiguration])

  useEffect(() => {
    if (!WORKER_URL) return undefined
    const timer = window.setInterval(() => { loadStatus().catch(() => {}) }, 5 * 60 * 1000)
    return () => window.clearInterval(timer)
  }, [loadStatus])

  useEffect(() => {
    if (!WORKER_URL || loading) return
    const snapshot = buildWatches().map((watch) => `${watch.opportunityId}:${JSON.stringify(watch.rules)}:${watch.pocEmail}:${watch.submissionDate}:${watch.decisions.map((d) => `${d.Decision}:${d['Follow-up Notice ID']}:${d['Follow-up Solicitation Number']}`).join(',')}`).join('|')
    if (snapshot === fingerprint.current) return
    fingerprint.current = snapshot
    synchronize().then(loadStatus).catch((err) => setError(err.message))
  }, [buildWatches, loadStatus, loading, synchronize])

  useEffect(() => {
    const expirations = Object.values(statusByOpportunity)
      .map((status) => Date.parse(status.seenUntil || ''))
      .filter((value) => Number.isFinite(value) && value > Date.now())
    if (!expirations.length) return undefined
    const timer = window.setTimeout(() => {
      const now = Date.now()
      setStatusByOpportunity((previous) => Object.fromEntries(Object.entries(previous).map(([key, status]) => [key,
        status.seenUntil && Date.parse(status.seenUntil) <= now ? { ...status, badgeVisible: false } : status,
      ])))
    }, Math.max(0, Math.min(...expirations) - Date.now() + 100))
    return () => window.clearTimeout(timer)
  }, [statusByOpportunity])

  return { globalRules, overrides, decisions, statusByOpportunity, loading, checking, error, refreshConfiguration, synchronize, loadStatus, checkOne, markSeen, applyDecision }
}
