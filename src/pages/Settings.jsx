import { useState, useEffect } from 'react'
import Topbar from '@/components/Layout/Topbar'
import { useValidationLists } from '@/hooks/useValidationLists'
import { useSAMOpportunities } from '@/hooks/useSAMOpportunities'
import { useTheme } from '@/theme/ThemeContext'
import { WORKER_URL, workerFetch } from '@/services/workerClient'
import {
  VALIDATION_KEY_MAP,
  OPPORTUNITY_PHASES, OPPORTUNITY_OUTLOOK, PRIORITY_VALUES,
  SET_ASIDE_VALUES, CONTACT_TYPES,
  getSAMNAICS, updateSAMNAICS, getSAMSettings, updateSAMSettings,
} from '@/services/graphService'
import styles from './Settings.module.css'

// Fallback defaults used only if the Data Validation column is missing/empty
const FALLBACKS = {
  opportunityPhases: OPPORTUNITY_PHASES,
  activityPhases: ['Pre-RFP', 'Submitted RFI', 'RFP Released', 'Proposal Submitted', 'BAFO', 'Award Pending'],
  outlooks: OPPORTUNITY_OUTLOOK,
  priorities: PRIORITY_VALUES,
  setAsides: SET_ASIDE_VALUES,
  primeOrSub: ['Prime', 'Sub'],
  bidNoBid: ['Bid', 'No Bid', 'TBD'],
  contactTypes: CONTACT_TYPES,
}

const SECTIONS = [
  { key: 'opportunityPhases', label: 'Opportunity Phases (TAG Phase)' },
  { key: 'activityPhases',    label: 'Activity Phases (Pipeline Activity)' },
  { key: 'outlooks',          label: 'Opportunity Outlooks' },
  { key: 'priorities',        label: 'Priority Values' },
  { key: 'setAsides',         label: 'Set-Aside Values' },
  { key: 'primeOrSub',        label: 'Prime or Sub Options' },
  { key: 'bidNoBid',          label: 'Bid / No Bid Options' },
  { key: 'contactTypes',      label: 'Contact Types' },
]

const AUTOMATION_STATUS = {
  success: { label: 'Healthy', className: 'integrationReady' },
  partial: { label: 'Continuing', className: 'integrationPending' },
  running: { label: 'Running', className: 'integrationPending' },
  error: { label: 'Needs attention', className: 'integrationError' },
  not_run: { label: 'Waiting for first run', className: 'integrationPending' },
  not_configured: { label: 'Not configured', className: 'integrationNotConfigured' },
}

function formatHealthTime(value) {
  const date = value ? new Date(value) : null
  return date && !Number.isNaN(date.getTime()) ? date.toLocaleString() : 'Not available yet'
}

export default function Settings({ toast }) {
  const { lists, loading, update } = useValidationLists()
  const { triggerPull } = useSAMOpportunities()
  const { preference: themePreference, resolvedTheme, setThemePreference } = useTheme()
  const [drafts, setDrafts] = useState({})
  const [savingKey, setSavingKey] = useState(null)
  const [savedKey, setSavedKey] = useState(null)
  const [integrationStatus, setIntegrationStatus] = useState(null)
  const [loadingIntegrations, setLoadingIntegrations] = useState(false)
  const [refreshingCapabilities, setRefreshingCapabilities] = useState(false)

  // ── SAM config state ─────────────────────────────────────────────────
  const [naicsCodes,    setNaicsCodes]    = useState([])
  const [skipDays,      setSkipDays]      = useState(3)
  const [windowDays,    setWindowDays]    = useState(90)
  const [rfiFollowUp,   setRfiFollowUp]   = useState({
    monitoringEnabled: true, departmentRule: 'Exact', agencyRule: 'Exact', pocRule: 'Exact',
    titleOverlapPercent: 40, noticeTypes: 'RFP, RFQ', submissionWindowDays: 364,
    noSubmissionLookbackDays: 150, noSubmissionLookaheadDays: 150,
  })
  const [samLoaded,     setSamLoaded]     = useState(false)
  const [savingSAM,     setSavingSAM]     = useState(false)
  const [savedSAM,      setSavedSAM]      = useState(false)
  const [triggering,    setTriggering]    = useState(false)
  const [triggerResult, setTriggerResult] = useState(null)
  // Collapsible sections — all collapsed on first load
  const [openSections,  setOpenSections]  = useState({
    dropdowns: false,
    health:    false,
    sam:       false,
  })
  const toggleSection = (key) => setOpenSections((prev) => ({ ...prev, [key]: !prev[key] }))
  // Per-card collapsible state, for long option lists nested inside a section
  // (collapsed by default for lists over LONG_LIST_THRESHOLD items)
  const [openLists, setOpenLists] = useState({})
  const toggleList = (key) => setOpenLists((prev) => ({ ...prev, [key]: !prev[key] }))
  const LONG_LIST_THRESHOLD = 6

  const loadIntegrationStatus = async () => {
    if (!WORKER_URL) {
      setIntegrationStatus({ capabilities: { status: 'unavailable', message: 'Worker URL is not configured.' } })
      return
    }
    setLoadingIntegrations(true)
    try {
      const response = await workerFetch('/integrations/status', { cache: 'no-store' })
      const payload = await response.json()
      if (!response.ok) throw new Error(payload.error || 'Could not load integration status')
      setIntegrationStatus(payload)
    } catch (err) {
      setIntegrationStatus({ capabilities: { status: 'unavailable', message: err.message } })
    } finally {
      setLoadingIntegrations(false)
    }
  }

  const handleCapabilitiesRefresh = async () => {
    if (!WORKER_URL) {
      toast?.error('Worker URL is not configured')
      return
    }
    setRefreshingCapabilities(true)
    try {
      const response = await workerFetch('/integrations/capabilities/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      })
      const payload = await response.json()
      if (!response.ok || !payload.ok) throw new Error(payload.error || 'Could not check the capabilities document')
      setIntegrationStatus((previous) => ({ ...previous, capabilities: payload.capabilities }))
      if (payload.throttled) toast?.info('The document was checked recently. Please try again in a few minutes.')
      else if (payload.changed) toast?.success('Capabilities document updated')
      else toast?.success('Capabilities document is up to date')
    } catch (err) {
      toast?.error(err.message)
    } finally {
      setRefreshingCapabilities(false)
    }
  }

  useEffect(() => {
    Promise.all([getSAMNAICS(), getSAMSettings()]).then(([codes, settings]) => {
      setNaicsCodes(codes)
      setSkipDays(settings.skipDays)
      setWindowDays(settings.windowDays)
      setRfiFollowUp(settings.rfiFollowUp)
      setSamLoaded(true)
    }).catch((err) => {
      console.warn('[Settings] Failed to load SAM config:', err.message)
      setSamLoaded(true)
    })
  }, [])

  useEffect(() => { loadIntegrationStatus() }, [])

  const handleSaveSAM = async () => {
    setSavingSAM(true)
    setSavedSAM(false)
    try {
      const cleanedCodes = naicsCodes.map((c) => String(c).trim()).filter(Boolean)
      await Promise.all([
        updateSAMNAICS(cleanedCodes),
        updateSAMSettings(Number(skipDays), Number(windowDays), rfiFollowUp),
      ])
      setNaicsCodes(cleanedCodes)
      setSavedSAM(true)
      toast?.success('SAM.gov settings saved')
    } catch (err) {
      toast?.error(`Failed to save: ${err.message}`)
    } finally {
      setSavingSAM(false)
    }
  }

  const handleTriggerSAM = async () => {
    setTriggering(true)
    setTriggerResult(null)
    try {
      const result = await triggerPull({ force: true, source: 'settings' })   // force=true bypasses 12h throttle
      setTriggerResult({ ok: true, message: result.message || 'Pull started' })
      toast?.success('SAM pull started')
    } catch (err) {
      setTriggerResult({ ok: false, message: err.message })
      toast?.error(`Trigger failed: ${err.message}`)
    } finally {
      setTriggering(false)
    }
  }

  // Initialize / refresh local drafts whenever live lists load or change,
  // but don't clobber a section the user is actively editing.
  useEffect(() => {
    if (loading) return
    setDrafts((prev) => {
      const next = { ...prev }
      SECTIONS.forEach(({ key }) => {
        if (next[key] !== undefined) return // keep existing draft
        const header = VALIDATION_KEY_MAP[key]
        const live = lists[header]
        next[key] = (live && live.length > 0) ? [...live] : [...FALLBACKS[key]]
      })
      return next
    })
  }, [lists, loading])

  const updateItem = (key, index, value) => {
    setDrafts((prev) => {
      const list = [...(prev[key] || [])]
      list[index] = value
      return { ...prev, [key]: list }
    })
    setSavedKey(null)
  }

  const addItem = (key) => {
    setDrafts((prev) => ({ ...prev, [key]: [...(prev[key] || []), ''] }))
    setSavedKey(null)
  }

  const removeItem = (key, index) => {
    setDrafts((prev) => ({
      ...prev,
      [key]: (prev[key] || []).filter((_, i) => i !== index),
    }))
    setSavedKey(null)
  }

  const handleSave = async (key) => {
    const header = VALIDATION_KEY_MAP[key]
    const cleaned = (drafts[key] || []).map((s) => s.trim()).filter((s) => s !== '')
    setSavingKey(key)
    try {
      await update(header, cleaned)
      setDrafts((prev) => ({ ...prev, [key]: cleaned }))
      setSavedKey(key)
      toast?.success('Settings saved')
    } catch (err) {
      toast?.error(`Failed to save: ${err.message}`)
    } finally {
      setSavingKey(null)
    }
  }

  return (
    <>
      <Topbar
        title="Settings"
        subtitle1="Manage dropdown options and app configuration"
        showFilter={false}
        showNew={false}
      />
      <div className="page-body">

        <div className={styles.themeCard}>
          <div>
            <div className={styles.themeTitle}>Appearance</div>
            <p className="text-xs text-muted">Choose how the Pipeline Manager looks on this device.</p>
          </div>
          <label className={styles.themeControl}>
            <span className="text-xs text-muted">Theme</span>
            <select className="form-input" value={themePreference} onChange={(event) => setThemePreference(event.target.value)}>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
              <option value="system">System ({resolvedTheme})</option>
            </select>
          </label>
        </div>

        <div className={styles.integrationCard}>
          <div>
            <div className={styles.themeTitle}>Integrations</div>
            <div className={styles.integrationRow}>
              {(() => {
                const capabilities = integrationStatus?.capabilities
                const status = capabilities?.status || 'checking'
                const label = {
                  ready: 'Ready',
                  pending: 'Waiting for first AI retrieval',
                  not_configured: 'Not configured',
                  error: 'Needs attention',
                  unavailable: 'Unavailable',
                  checking: 'Checking',
                }[status] || 'Checking'
                return <span className={`${styles.integrationBadge} ${styles[`integration${status[0].toUpperCase()}${status.slice(1).replace(/_([a-z])/g, (_, c) => c.toUpperCase())}`] || ''}`}>{label}</span>
              })()}
              <span className="text-xs text-muted">AI capabilities document</span>
            </div>
            <p className="text-xs text-muted" style={{ marginTop: 5 }}>
              {integrationStatus?.capabilities?.message || 'Checking the Worker configuration.'}
              {integrationStatus?.capabilities?.fileName ? ` ${integrationStatus.capabilities.fileName}.` : ''}
            </p>
            {integrationStatus?.capabilities?.fetchedAt && (
              <p className="text-xs text-muted" style={{ marginTop: 3 }}>
                Retrieved {new Date(integrationStatus.capabilities.fetchedAt).toLocaleString()}.
              </p>
            )}
            {integrationStatus?.capabilities?.lastCheckedAt && (
              <p className="text-xs text-muted" style={{ marginTop: 3 }}>
                Last checked {new Date(integrationStatus.capabilities.lastCheckedAt).toLocaleString()}.
              </p>
            )}
            <div className={styles.integrationRow} style={{ marginTop: 10 }}>
              <span className={`${styles.integrationBadge} ${integrationStatus?.notifications?.appOnlyAvailable ? styles.integrationReady : styles.integrationNotConfigured}`}>
                {integrationStatus?.notifications?.appOnlyAvailable ? 'Scheduled' : 'Browser fallback'}
              </span>
              <span className="text-xs text-muted">Teams reminders</span>
            </div>
            <p className="text-xs text-muted" style={{ marginTop: 5 }}>
              {integrationStatus?.notifications?.appOnlyAvailable
                ? integrationStatus.notifications.lastRun?.ok === false
                  ? `Last scheduled run needs attention: ${integrationStatus.notifications.lastRun.message || 'Unknown error'}`
                  : 'Runs from the Worker at the configured schedule. The browser is retained as a fallback.'
                : 'The browser sends scheduled reminders until app-only Worker access is available.'}
            </p>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            <button className="btn btn-primary" type="button" onClick={handleCapabilitiesRefresh} disabled={refreshingCapabilities}>
              {refreshingCapabilities ? 'Checking…' : 'Check document'}
            </button>
            <button className="btn btn-ghost" type="button" onClick={loadIntegrationStatus} disabled={loadingIntegrations}>
              {loadingIntegrations ? 'Checking…' : 'Refresh status'}
            </button>
          </div>
        </div>

        <div className={styles.collapsible}>
          <button className={styles.collapsibleHeader} onClick={() => toggleSection('health')}>
            <span>
              <span className={styles.collapsibleTitle}>Automation Health</span>
              <span className={styles.collapsibleHint}>Scheduled Worker jobs and integration checks</span>
            </span>
            <span className={`${styles.chevron} ${openSections.health ? styles.chevronOpen : ''}`}>›</span>
          </button>
          {openSections.health && (
            <div className={styles.healthBody}>
              {!integrationStatus?.automation?.length ? (
                <p className="text-xs text-muted">Refresh status to load automation health.</p>
              ) : (
                <div className={styles.healthTableWrap}>
                  <table className={styles.healthTable}>
                    <thead>
                      <tr>
                        <th scope="col">Process</th>
                        <th scope="col">Schedule</th>
                        <th scope="col">Status</th>
                        <th scope="col">Last successful</th>
                        <th scope="col">Last issue</th>
                      </tr>
                    </thead>
                    <tbody>
                      {integrationStatus.automation.map((job) => {
                        const status = AUTOMATION_STATUS[job.status] || AUTOMATION_STATUS.not_run
                        const issue = job.lastFailureMessage || job.message
                        return (
                          <tr key={job.id}>
                            <td className={styles.healthProcess}>{job.label}</td>
                            <td>{job.schedule}</td>
                            <td><span className={`${styles.integrationBadge} ${styles[status.className]}`}>{status.label}</span></td>
                            <td>{formatHealthTime(job.lastSuccessAt)}</td>
                            <td className={issue ? styles.healthIssue : undefined}>
                              {job.lastFailureAt ? <span>{formatHealthTime(job.lastFailureAt)}</span> : null}
                              {issue ? <span className={styles.healthIssueMessage}>{issue}</span> : (!job.lastFailureAt && 'None recorded')}
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </div>

        {/* ── Collapsible: Dropdown Options ── */}
        <div className={styles.collapsible}>
          <button className={styles.collapsibleHeader} onClick={() => toggleSection('dropdowns')}>
            <span className={styles.collapsibleTitle}>Dropdown Options</span>
            <span className={`${styles.chevron} ${openSections.dropdowns ? styles.chevronOpen : ''}`}>›</span>
          </button>
          {openSections.dropdowns && (
            <div className={styles.collapsibleBody}>
              {loading
                ? <div className="skeleton" style={{ height: 200 }} />
                : (
                  <div className={styles.grid}>
                    {SECTIONS.map(({ key, label }) => {
                      const items = drafts[key] || []
                      const isLong = items.length > LONG_LIST_THRESHOLD
                      const isOpen = openLists[key] ?? !isLong   // long lists default closed, short ones default open
                      return (
                        <div key={key} className="card">
                          <button
                            type="button"
                            onClick={() => isLong && toggleList(key)}
                            style={{
                              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                              width: '100%', background: 'none', border: 'none', padding: 0,
                              cursor: isLong ? 'pointer' : 'default', font: 'inherit', textAlign: 'left',
                            }}
                          >
                            <div className={styles.sectionLabel} style={{ marginBottom: 0 }}>
                              {label} {isLong && <span className="text-xs text-muted">({items.length})</span>}
                            </div>
                            {isLong && (
                              <span className={`${styles.chevron} ${isOpen ? styles.chevronOpen : ''}`}>›</span>
                            )}
                          </button>
                          {isOpen && (
                            <>
                              <div className={styles.itemList} style={{ marginTop: 8 }}>
                                {items.map((val, i) => (
                                  <div key={i} className={styles.itemRow}>
                                    <input
                                      className="form-input"
                                      value={val}
                                      onChange={(e) => updateItem(key, i, e.target.value)}
                                    />
                                    <button
                                      className="btn btn-ghost btn-icon"
                                      onClick={() => removeItem(key, i)}
                                      aria-label="Remove"
                                      title="Remove"
                                    >✕</button>
                                  </div>
                                ))}
                              </div>
                              <div className={styles.saveRow} style={{ paddingBottom: 0 }}>
                                <button className={styles.addBtn} onClick={() => addItem(key)}>
                                  + Add option
                                </button>
                                <button
                                  className="btn btn-primary"
                                  style={{ marginLeft: 'auto' }}
                                  onClick={() => handleSave(key)}
                                  disabled={savingKey === key}
                                >
                                  {savingKey === key ? 'Saving…' : savedKey === key ? '✓ Saved' : 'Save'}
                                </button>
                              </div>
                            </>
                          )}
                        </div>
                      )
                    })}
                  </div>
                )
              }
              <p className="text-xs text-muted" style={{ marginTop: 12 }}>
                These options are shared across all users and stored on the Data Validation sheet of the workbook.
                Task statuses and task priorities are fixed and not configurable here.
              </p>
            </div>
          )}
        </div>

        {/* ── Collapsible: SAM.gov API ── */}
        <div className={styles.collapsible} style={{ marginTop: 10 }}>
          <button className={styles.collapsibleHeader} onClick={() => toggleSection('sam')}>
            <span className={styles.collapsibleTitle}>SAM.gov API</span>
            <span className={`${styles.chevron} ${openSections.sam ? styles.chevronOpen : ''}`}>›</span>
          </button>
          {openSections.sam && (
            <div className={styles.collapsibleBody}>
              <p className="text-xs text-muted" style={{ marginBottom: 14 }}>
                Controls the pull of Sources Sought opportunities from SAM.gov.
              </p>

          {!samLoaded
            ? <div className="skeleton" style={{ height: 120 }} />
            : (
              <div className={styles.grid}>
                {/* NAICS codes */}
                <div className="card">
                  <button
                    type="button"
                    onClick={() => naicsCodes.length > LONG_LIST_THRESHOLD && toggleList('naics')}
                    style={{
                      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                      width: '100%', background: 'none', border: 'none', padding: 0,
                      cursor: naicsCodes.length > LONG_LIST_THRESHOLD ? 'pointer' : 'default', font: 'inherit', textAlign: 'left',
                    }}
                  >
                    <div className={styles.sectionLabel} style={{ marginBottom: 0 }}>
                      NAICS Codes {naicsCodes.length > LONG_LIST_THRESHOLD && <span className="text-xs text-muted">({naicsCodes.length})</span>}
                    </div>
                    {naicsCodes.length > LONG_LIST_THRESHOLD && (
                      <span className={`${styles.chevron} ${(openLists.naics ?? false) ? styles.chevronOpen : ''}`}>›</span>
                    )}
                  </button>
                  {(naicsCodes.length <= LONG_LIST_THRESHOLD || (openLists.naics ?? false)) && (
                    <>
                      <div className={styles.itemList} style={{ marginTop: 8 }}>
                        {naicsCodes.map((code, i) => (
                          <div key={i} className={styles.itemRow}>
                            <input
                              className="form-input"
                              value={code}
                              onChange={(e) => {
                                const next = [...naicsCodes]
                                next[i] = e.target.value
                                setNaicsCodes(next)
                                setSavedSAM(false)
                              }}
                            />
                            <button
                              className="btn btn-ghost btn-icon"
                              onClick={() => { setNaicsCodes(naicsCodes.filter((_, j) => j !== i)); setSavedSAM(false) }}
                              aria-label="Remove"
                            >✕</button>
                          </div>
                        ))}
                      </div>
                      <div className={styles.saveRow}>
                        <button className={styles.addBtn}
                          onClick={() => { setNaicsCodes([...naicsCodes, '']); setSavedSAM(false) }}>
                          + Add NAICS code
                        </button>
                      </div>
                    </>
                  )}
                </div>

                {/* Window settings */}
                <div className="card">
                  <div className={styles.sectionLabel}>Response Deadline Window</div>
                  <div className={styles.itemList}>
                    <div className="form-field">
                      <label className="form-label">Skip Days</label>
                      <input className="form-input" type="number" min={0} max={30}
                        value={skipDays}
                        onChange={(e) => { setSkipDays(e.target.value); setSavedSAM(false) }} />
                      <span className="text-xs text-muted" style={{ marginTop: 3 }}>
                        Exclude opportunities with a deadline within this many days (avoids noise on imminent deadlines)
                      </span>
                    </div>
                    <div className="form-field" style={{ marginTop: 10 }}>
                      <label className="form-label">Window Days</label>
                      <input className="form-input" type="number" min={7} max={365}
                        value={windowDays}
                        onChange={(e) => { setWindowDays(e.target.value); setSavedSAM(false) }} />
                      <span className="text-xs text-muted" style={{ marginTop: 3 }}>
                        Pull opportunities whose deadline falls within this many days from today
                      </span>
                    </div>
                  </div>
                </div>

                <div className="card">
                  <div className={styles.sectionLabel}>RFI Follow-up Matching</div>
                  <p className="text-xs text-muted" style={{ margin: '4px 0 10px' }}>
                    Defaults for SAM.gov follow-on checks. Individual RFIs can override these rules.
                  </p>
                  <div className={styles.itemList}>
                    <label className="text-sm" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <input type="checkbox" checked={rfiFollowUp.monitoringEnabled}
                        onChange={(e) => { setRfiFollowUp((prev) => ({ ...prev, monitoringEnabled: e.target.checked })); setSavedSAM(false) }} />
                      Check RFIs in the background
                    </label>
                    {[
                      ['departmentRule', 'Department match'],
                      ['agencyRule', 'Agency match'],
                      ['pocRule', 'POC email match'],
                    ].map(([key, label]) => (
                      <div className="form-field" key={key} style={{ marginTop: 8 }}>
                        <label className="form-label">{label}</label>
                        <select className="form-select" value={rfiFollowUp[key]}
                          onChange={(e) => { setRfiFollowUp((prev) => ({ ...prev, [key]: e.target.value })); setSavedSAM(false) }}>
                          <option value="Exact">Exact</option><option value="Ignore">Ignore</option>
                        </select>
                      </div>
                    ))}
                    <div className="form-field" style={{ marginTop: 8 }}>
                      <label className="form-label">Minimum title overlap (%)</label>
                      <input className="form-input" type="number" min={1} max={100} value={rfiFollowUp.titleOverlapPercent}
                        onChange={(e) => { setRfiFollowUp((prev) => ({ ...prev, titleOverlapPercent: e.target.value })); setSavedSAM(false) }} />
                    </div>
                    <div className="form-field" style={{ marginTop: 8 }}>
                      <label className="form-label">Notice types</label>
                      <select className="form-select" value={rfiFollowUp.noticeTypes}
                        onChange={(e) => { setRfiFollowUp((prev) => ({ ...prev, noticeTypes: e.target.value })); setSavedSAM(false) }}>
                        <option value="RFP, RFQ">RFP and RFQ</option><option value="RFP">RFP only</option><option value="RFQ">RFQ only</option>
                      </select>
                    </div>
                    <div className="form-field" style={{ marginTop: 8 }}>
                      <label className="form-label">Post-submission window (days)</label>
                      <input className="form-input" type="number" min={1} max={364} value={rfiFollowUp.submissionWindowDays}
                        onChange={(e) => { setRfiFollowUp((prev) => ({ ...prev, submissionWindowDays: e.target.value })); setSavedSAM(false) }} />
                    </div>
                    <div className="form-field" style={{ marginTop: 8 }}>
                      <label className="form-label">No-submission window (days before / after today)</label>
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                        <input className="form-input" aria-label="Days before today" type="number" min={0} max={364} value={rfiFollowUp.noSubmissionLookbackDays}
                          onChange={(e) => { setRfiFollowUp((prev) => ({ ...prev, noSubmissionLookbackDays: e.target.value })); setSavedSAM(false) }} />
                        <input className="form-input" aria-label="Days after today" type="number" min={0} max={364} value={rfiFollowUp.noSubmissionLookaheadDays}
                          onChange={(e) => { setRfiFollowUp((prev) => ({ ...prev, noSubmissionLookaheadDays: e.target.value })); setSavedSAM(false) }} />
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            )
          }

          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <button className={`btn ${styles.triggerPullBtn}`} onClick={handleTriggerSAM} disabled={triggering}
                title="Manually run the SAM.gov pull now">
                {triggering ? '⏳ Running…' : '▶ Trigger pull now'}
              </button>
              {triggerResult && (
                <span style={{ fontSize: 12, color: triggerResult.ok ? 'var(--green-600)' : 'var(--red-600)' }}>
                  {triggerResult.ok ? '✓ ' : '✗ '}{triggerResult.message}
                </span>
              )}
            </div>
            <button className="btn btn-primary" onClick={handleSaveSAM} disabled={savingSAM}>
              {savingSAM ? 'Saving…' : savedSAM ? '✓ Saved' : 'Save SAM settings'}
            </button>
          </div>

              {/* API key note */}
              <div style={{
                marginTop: 12, padding: '12px 14px',
                background: 'var(--gray-50)', border: '0.5px solid var(--gray-200)',
                borderRadius: 'var(--radius-md)', fontSize: 12, color: 'var(--gray-600)', lineHeight: 1.6,
              }}>
                <strong style={{ color: 'var(--gray-900)' }}>API key rotation</strong><br />
                SAM.gov public API keys expire every 90 days. When yours expires, the pull will stop
                and a warning banner will appear on the New Opportunities tab.<br />
                To rotate: run <code style={{ background: 'var(--gray-200)', padding: '1px 5px', borderRadius: 3 }}>wrangler secret put SAM_API_KEY</code> in your terminal, paste your new key, and deploy.
                No code changes required.
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  )
}
