import { useState, useEffect, useRef } from 'react'
import Topbar from '@/components/Layout/Topbar'
import EbuySyncProgress from '@/components/Common/EbuySyncProgress'
import FollowUpEmailTemplates from '@/components/Settings/FollowUpEmailTemplates'
import LegacyFolderMigration from '@/components/Settings/LegacyFolderMigration'
import { useAuth } from '@/auth/AuthContext'
import { useValidationLists } from '@/hooks/useValidationLists'
import { useSAMOpportunities } from '@/hooks/useSAMOpportunities'
import { useTheme } from '@/theme/ThemeContext'
import { WORKER_URL, workerFetch } from '@/services/workerClient'
import {
  connectEbuyAccount,
  disconnectEbuyAccount,
  getEbuyStatus,
  startEbuyLiveSync,
  testEbuyConnection,
} from '@/services/ebuyService'
import {
  VALIDATION_KEY_MAP,
  OPPORTUNITY_PHASES, OPPORTUNITY_OUTLOOK, PRIORITY_VALUES,
  SET_ASIDE_VALUES, CONTACT_TYPES,
  getSAMNAICS, updateSAMNAICS, getSAMSettings, updateSAMSettings,
  isInteractionRequiredError,
} from '@/services/graphService'
import styles from './Settings.module.css'
import { useSaveShortcut } from '@/shortcuts/SaveShortcutContext'

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
  { key: 'opportunityPhases', label: 'Opportunity phases' },
  { key: 'activityPhases',    label: 'Activity phases' },
  { key: 'outlooks',          label: 'Opportunity outlook options' },
  { key: 'priorities',        label: 'Pursuit priorities' },
  { key: 'setAsides',         label: 'Set-asides' },
  { key: 'primeOrSub',        label: 'Prime or sub' },
  { key: 'bidNoBid',          label: 'Bid decision options' },
  { key: 'contactTypes',      label: 'Contact types' },
]

const AUTOMATION_STATUS = {
  success: { label: 'Healthy', className: 'integrationReady' },
  partial: { label: 'Continuing', className: 'integrationPending' },
  running: { label: 'Running', className: 'integrationPending' },
  error: { label: 'Needs attention', className: 'integrationError' },
  not_run: { label: 'Waiting for first run', className: 'integrationPending' },
  not_configured: { label: 'Not configured', className: 'integrationNotConfigured' },
}

const CAPABILITIES_STATUS = {
  ready: { label: 'Ready', className: 'integrationReady' },
  pending: { label: 'Waiting for first retrieval', className: 'integrationPending' },
  not_configured: { label: 'Not configured', className: 'integrationNotConfigured' },
  error: { label: 'Needs attention', className: 'integrationError' },
  unavailable: { label: 'Unavailable', className: 'integrationUnavailable' },
  auth_required: { label: 'Sign-in required', className: 'integrationPending' },
  checking: { label: 'Checking', className: 'integrationPending' },
}

function formatHealthTime(value) {
  const date = value ? new Date(value) : null
  return date && !Number.isNaN(date.getTime())
    ? date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short', hour12: true })
    : 'Not available yet'
}

function capabilityIntegration(capabilities) {
  const status = CAPABILITIES_STATUS[capabilities?.status || 'checking'] || CAPABILITIES_STATUS.checking
  const details = [
    capabilities?.message || 'Checking integration status.',
    capabilities?.fileName,
    capabilities?.lastCheckedAt ? `Checked ${formatHealthTime(capabilities.lastCheckedAt)}` : null,
  ].filter(Boolean).join(' · ')
  return { status, details }
}

function teamsIntegration(notifications) {
  const scheduled = notifications?.appOnlyAvailable
  const lastRun = notifications?.lastRun
  const needsAttention = scheduled && lastRun?.ok === false
  const status = needsAttention
    ? { label: 'Needs attention', className: 'integrationError' }
    : scheduled
      ? { label: 'Scheduled', className: 'integrationReady' }
      : { label: 'Available while app is open', className: 'integrationNotConfigured' }
  const details = needsAttention
    ? lastRun.message || 'The most recent scheduled reminder run did not complete.'
    : scheduled
      ? 'Scheduled delivery is ready. In-app delivery remains available as a backup.'
      : 'The app can send reminders while it remains open.'
  return {
    status,
    details: lastRun?.timestamp ? `${details} · Last run ${formatHealthTime(lastRun.timestamp)}` : details,
  }
}

function ebuyIntegration(ebuy) {
  if (!ebuy) return { status: { label: 'Checking', className: 'integrationPending' }, details: 'Checking eBuy archive status.' }
  const status = ({
    ready: { label: ebuy.connector?.enabled ? 'Connected' : 'Not connected', className: ebuy.connector?.enabled ? 'integrationReady' : 'integrationPending' },
    migration_required: { label: 'Setup required', className: 'integrationPending' },
    not_configured: { label: 'Not configured', className: 'integrationNotConfigured' },
    error: { label: 'Needs attention', className: 'integrationError' },
  })[ebuy.status] || { label: 'Unavailable', className: 'integrationUnavailable' }
  const count = Number(ebuy.opportunityCount || 0)
  const runError = ebuy.lastSync?.status === 'error'
    ? ebuy.lastSync.error_message || ebuy.lastSync.progress?.message || ebuy.message
    : ''
  return {
    status,
    details: `${runError || ebuy.connector?.message || ebuy.message || 'eBuy archive status is unavailable.'}${count ? ` · ${count} archived opportunities` : ''}`,
  }
}

export default function Settings({ toast }) {
  const { user } = useAuth()
  const { lists, loading, update } = useValidationLists()
  const { triggerPull } = useSAMOpportunities()
  const { preference: themePreference, resolvedTheme, setThemePreference } = useTheme()
  const [drafts, setDrafts] = useState({})
  const [savingKey, setSavingKey] = useState(null)
  const [savedKey, setSavedKey] = useState(null)
  const [integrationStatus, setIntegrationStatus] = useState(null)
  const [loadingIntegrations, setLoadingIntegrations] = useState(false)
  const [refreshingCapabilities, setRefreshingCapabilities] = useState(false)
  const [ebuyConnectionForm, setEbuyConnectionForm] = useState({ username: '', password: '', totpSecret: '' })
  const [showEbuyConnectionForm, setShowEbuyConnectionForm] = useState(false)
  const [ebuyConnecting, setEbuyConnecting] = useState(false)
  const [ebuyTestingConnection, setEbuyTestingConnection] = useState(false)
  const [ebuyLiveSyncing, setEbuyLiveSyncing] = useState(false)
  const [ebuyDisconnecting, setEbuyDisconnecting] = useState(false)

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
  const [focusedValidationKey, setFocusedValidationKey] = useState(null)
  const dropdownScopeRef = useRef(null)
  const samScopeRef = useRef(null)
  // Collapsible sections — all collapsed on first load
  const [openSections,  setOpenSections]  = useState({
    dropdowns: false,
    health:    false,
    emailTemplates: false,
    folderMigration: false,
    sam:       false,
    ebuy:      false,
  })
  const toggleSection = (key) => setOpenSections((prev) => ({ ...prev, [key]: !prev[key] }))
  // Per-card collapsible state, for long option lists nested inside a section
  // (collapsed by default for lists over LONG_LIST_THRESHOLD items)
  const [openLists, setOpenLists] = useState({})
  const toggleList = (key) => setOpenLists((prev) => ({ ...prev, [key]: !prev[key] }))
  const LONG_LIST_THRESHOLD = 6
  const capabilities = integrationStatus?.capabilities
  const capabilityIntegrationStatus = capabilityIntegration(capabilities)
  const teamsIntegrationStatus = teamsIntegration(integrationStatus?.notifications)
  const ebuyIntegrationStatus = ebuyIntegration(integrationStatus?.ebuy)

  const handleEbuyConnect = async (event) => {
    event.preventDefault()
    if (ebuyConnecting) return
    setEbuyConnecting(true)
    try {
      await connectEbuyAccount(ebuyConnectionForm)
      setEbuyConnectionForm({ username: '', password: '', totpSecret: '' })
      setShowEbuyConnectionForm(false)
      await loadIntegrationStatus()
      toast?.success('Company eBuy account connected')
    } catch (error) {
      toast?.error(`Could not connect eBuy: ${error.message}`)
    } finally {
      setEbuyConnecting(false)
    }
  }

  const handleEbuyConnectionTest = async () => {
    if (ebuyTestingConnection) return
    setEbuyTestingConnection(true)
    try {
      await testEbuyConnection()
      await loadIntegrationStatus()
      toast?.success('eBuy connection verified')
    } catch (error) {
      await loadIntegrationStatus()
      toast?.error(`eBuy connection needs attention: ${error.message}`)
    } finally {
      setEbuyTestingConnection(false)
    }
  }

  const handleEbuyLiveSync = async () => {
    if (ebuyLiveSyncing || integrationStatus?.ebuy?.lastSync?.status === 'running') return
    setEbuyLiveSyncing(true)
    try {
      const result = await startEbuyLiveSync()
      setIntegrationStatus((current) => ({
        ...(current || {}),
        ebuy: {
          ...(current?.ebuy || {}),
          lastSync: {
            ...(current?.ebuy?.lastSync || {}),
            status: 'running',
            started_at: new Date().toISOString(),
            progress: { phase: 'preparing', percent: 2, message: result.alreadyRunning ? 'Joining the active eBuy synchronization' : 'Preparing eBuy synchronization' },
          },
        },
      }))
      toast?.success(result.alreadyRunning ? 'eBuy synchronization is already running' : 'eBuy synchronization started')
    } catch (error) {
      toast?.error(`Could not start eBuy synchronization: ${error.message}`)
    } finally {
      setEbuyLiveSyncing(false)
    }
  }

  const handleEbuyDisconnect = async () => {
    if (ebuyDisconnecting || !window.confirm('Disconnect the company eBuy account? Archived opportunities and files will remain available.')) return
    setEbuyDisconnecting(true)
    try {
      await disconnectEbuyAccount()
      await loadIntegrationStatus()
      setShowEbuyConnectionForm(false)
      toast?.success('eBuy account disconnected')
    } catch (error) {
      toast?.error(`Could not disconnect eBuy: ${error.message}`)
    } finally {
      setEbuyDisconnecting(false)
    }
  }

  const loadIntegrationStatus = async ({ interactive = false, notify = false } = {}) => {
    if (!WORKER_URL) {
      setIntegrationStatus({ capabilities: { status: 'unavailable', message: 'The integration service is not configured.' } })
      return
    }
    setLoadingIntegrations(true)
    try {
      const response = await workerFetch('/integrations/status', {
        cache: 'no-store',
        interactiveAuth: interactive,
      })
      const payload = await response.json()
      if (!response.ok) throw new Error(payload.error || 'Could not load integration status')
      setIntegrationStatus(payload)
      if (notify) toast?.success('Integration status updated')
    } catch (err) {
      const requiresSignIn = isInteractionRequiredError(err)
      const capabilities = requiresSignIn
        ? { status: 'auth_required', message: 'Sign in again to load integration status.' }
        : { status: 'unavailable', message: err.message }
      setIntegrationStatus({ capabilities, automation: null })
      if (notify) {
        toast?.error(requiresSignIn
          ? 'Microsoft sign-in is required to refresh integration status.'
          : `Could not refresh integration status: ${err.message}`)
      }
    } finally {
      setLoadingIntegrations(false)
    }
  }

  const handleCapabilitiesRefresh = async () => {
    if (!WORKER_URL) {
      toast?.error('The integration service is not configured')
      return
    }
    setRefreshingCapabilities(true)
    try {
      const response = await workerFetch('/integrations/capabilities/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        interactiveAuth: true,
      })
      const payload = await response.json()
      if (!response.ok || !payload.ok) throw new Error(payload.error || 'Could not check the capabilities document')
      setIntegrationStatus((previous) => ({ ...previous, capabilities: payload.capabilities }))
      await loadIntegrationStatus()
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
      setRfiFollowUp({ ...settings.rfiFollowUp, noticeTypes: 'RFP, RFQ' })
      setSamLoaded(true)
    }).catch((err) => {
      console.warn('[Settings] Failed to load SAM config:', err.message)
      setSamLoaded(true)
    })
  }, [])

  useEffect(() => { loadIntegrationStatus() }, [])

  useEffect(() => {
    if (integrationStatus?.ebuy?.lastSync?.status !== 'running') return undefined
    let disposed = false
    const refreshEbuyProgress = async () => {
      try {
        const ebuy = await getEbuyStatus()
        if (!disposed) setIntegrationStatus((current) => ({ ...(current || {}), ebuy }))
      } catch {
        // Preserve the last durable progress value through temporary status failures.
      }
    }
    const timer = window.setInterval(refreshEbuyProgress, 2000)
    return () => { disposed = true; window.clearInterval(timer) }
  }, [integrationStatus?.ebuy?.lastSync?.status])

  const handleSaveSAM = async () => {
    setSavingSAM(true)
    setSavedSAM(false)
    try {
      const cleanedCodes = naicsCodes.map((c) => String(c).trim()).filter(Boolean)
      await Promise.all([
        updateSAMNAICS(cleanedCodes),
        updateSAMSettings(Number(skipDays), Number(windowDays), { ...rfiFollowUp, noticeTypes: 'RFP, RFQ' }),
      ])
      setNaicsCodes(cleanedCodes)
      setSavedSAM(true)
      toast?.success('Discovery settings saved')
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
      toast?.success('SAM.gov opportunity pull started')
    } catch (err) {
      setTriggerResult({ ok: false, message: err.message })
      toast?.error(`Could not start the opportunity pull: ${err.message}`)
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
  useSaveShortcut({
    enabled: openSections.dropdowns && Boolean(focusedValidationKey) && !savingKey,
    label: focusedValidationKey
      ? `${SECTIONS.find((section) => section.key === focusedValidationKey)?.label || 'these dropdown options'}`
      : 'these dropdown options',
    onSave: () => focusedValidationKey && handleSave(focusedValidationKey),
    scopeRef: dropdownScopeRef,
  })
  useSaveShortcut({
    enabled: openSections.sam && samLoaded && !savingSAM,
    label: 'the SAM.gov settings',
    onSave: handleSaveSAM,
    scopeRef: samScopeRef,
  })

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
            <p className="text-xs text-muted">Choose how TAG CRM looks on this device.</p>
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
          <div className={styles.integrationHeader}>
            <div>
              <div className={styles.themeTitle}>Integrations</div>
              <p className="text-xs text-muted">Services used for scheduled activity and AI context.</p>
            </div>
            <button className="btn btn-ghost" type="button" onClick={() => loadIntegrationStatus({ interactive: true, notify: true })} disabled={loadingIntegrations}>
              {loadingIntegrations ? 'Checking…' : 'Refresh status'}
            </button>
          </div>

          <div className={styles.integrationTableWrap}>
            <table className={styles.integrationTable}>
              <thead>
                <tr>
                  <th scope="col">Integration</th>
                  <th scope="col">Status</th>
                  <th scope="col">Details</th>
                  <th scope="col" aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td className={styles.integrationName}>Capabilities document</td>
                  <td><span className={`${styles.integrationBadge} ${styles[capabilityIntegrationStatus.status.className]}`}>{capabilityIntegrationStatus.status.label}</span></td>
                  <td className={styles.integrationDetails}>{capabilityIntegrationStatus.details}</td>
                  <td className={styles.integrationAction}>
                    <button className="btn btn-primary" type="button" onClick={handleCapabilitiesRefresh} disabled={refreshingCapabilities}>
                      {refreshingCapabilities ? 'Checking…' : 'Check for updates'}
                    </button>
                  </td>
                </tr>
                <tr>
                  <td className={styles.integrationName}>Teams reminders</td>
                  <td><span className={`${styles.integrationBadge} ${styles[teamsIntegrationStatus.status.className]}`}>{teamsIntegrationStatus.status.label}</span></td>
                  <td className={styles.integrationDetails}>{teamsIntegrationStatus.details}</td>
                  <td className={styles.integrationAction}><span className="text-xs text-muted">Automatic</span></td>
                </tr>
                <tr>
                  <td className={styles.integrationName}>Email sending</td>
                  <td><span className={`${styles.integrationBadge} ${styles.integrationNotConfigured}`}>Draft only</span></td>
                  <td className={styles.integrationDetails}>Templates and editable drafts are available. Sending and Outlook actions remain disabled until Exchange mail permissions are granted.</td>
                  <td className={styles.integrationAction}><span className="text-xs text-muted">Automatic</span></td>
                </tr>
                <tr>
                  <td className={styles.integrationName}>GSA eBuy archive</td>
                  <td><span className={`${styles.integrationBadge} ${styles[ebuyIntegrationStatus.status.className]}`}>{ebuyIntegrationStatus.status.label}</span></td>
                  <td className={styles.integrationDetails}>{ebuyIntegrationStatus.details}</td>
                  <td className={styles.integrationAction}><button className="btn" type="button" onClick={() => toggleSection('ebuy')}>Configure</button></td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <div className={styles.collapsible}>
          <button className={styles.collapsibleHeader} onClick={() => toggleSection('ebuy')}>
              <span>
                <span className={styles.collapsibleTitle}>GSA eBuy archive</span>
                <span className={styles.collapsibleHint}>Secure company connection, autonomous synchronization, and SharePoint archive</span>
              </span>
            <span className={`${styles.chevron} ${openSections.ebuy ? styles.chevronOpen : ''}`}>›</span>
          </button>
          {openSections.ebuy && <div className={styles.collapsibleBody}>
            <div className={styles.ebuyStack}>
              <div className={`card ${styles.ebuyConnectionCard}`}>
                <div className={styles.ebuyCardHeader}>
                  <div>
                    <div className={styles.sectionLabel}>Company connection</div>
                    <div className={styles.ebuyConnectionTitle}>
                      {integrationStatus?.ebuy?.connector?.connection?.configured ? 'GSA eBuy connected' : 'Connect GSA eBuy'}
                    </div>
                    <p className="text-xs text-muted">
                      Credentials and the authenticator setup key are encrypted before D1 storage. TAG CRM never returns them to the browser.
                    </p>
                  </div>
                  <span className={`${styles.integrationBadge} ${styles[integrationStatus?.ebuy?.connector?.connection?.configured ? 'integrationReady' : 'integrationNotConfigured']}`}>
                    {integrationStatus?.ebuy?.connector?.connection?.configured ? 'Connected' : 'Not connected'}
                  </span>
                </div>

                {integrationStatus?.ebuy?.connector?.connection?.configured && !showEbuyConnectionForm && (
                  <div className={styles.ebuyConnectionSummary}>
                    <div><span>Account</span><strong>{integrationStatus.ebuy.connector.connection.usernameMasked || 'Connected account'}</strong></div>
                    <div><span>Contracts</span><strong>{integrationStatus.ebuy.connector.connection.contracts?.length || 0}</strong></div>
                    <div><span>Last verified</span><strong>{formatHealthTime(integrationStatus.ebuy.connector.connection.lastAuthenticatedAt)}</strong></div>
                    <div><span>Last synchronized</span><strong>{formatHealthTime(integrationStatus.ebuy.connector.connection.lastSyncAt)}</strong></div>
                  </div>
                )}

                {integrationStatus?.ebuy?.connector?.connection?.lastErrorMessage && (
                  <div className={styles.ebuyConnectionError}>{integrationStatus.ebuy.connector.connection.lastErrorMessage}</div>
                )}

                {integrationStatus?.ebuy?.connector?.connection?.configured && !showEbuyConnectionForm && (
                  <div className={styles.ebuyContractList}>
                    {(integrationStatus.ebuy.connector.connection.contracts || []).map((contract) => (
                      <div key={contract.contractNumber} className={styles.ebuyContractRow}>
                        <strong>{contract.contractNumber}</strong>
                        <span>{[contract.contractVehicle, contract.companyName].filter(Boolean).join(' · ') || 'Seller contract'}</span>
                      </div>
                    ))}
                  </div>
                )}

                {(!integrationStatus?.ebuy?.connector?.connection?.configured || showEbuyConnectionForm) && (
                  <form className={styles.ebuyConnectionForm} onSubmit={handleEbuyConnect}>
                    <label>
                      <span>FAS ID username</span>
                      <input className="form-input" type="text" autoComplete="username" value={ebuyConnectionForm.username} onChange={(event) => setEbuyConnectionForm((current) => ({ ...current, username: event.target.value }))} required disabled={ebuyConnecting} />
                    </label>
                    <label>
                      <span>FAS ID password</span>
                      <input className="form-input" type="password" autoComplete="current-password" value={ebuyConnectionForm.password} onChange={(event) => setEbuyConnectionForm((current) => ({ ...current, password: event.target.value }))} required disabled={ebuyConnecting} />
                    </label>
                    <label className={styles.ebuyTotpField}>
                      <span>Authenticator setup key</span>
                      <input className="form-input" type="password" autoComplete="off" value={ebuyConnectionForm.totpSecret} onChange={(event) => setEbuyConnectionForm((current) => ({ ...current, totpSecret: event.target.value }))} required disabled={ebuyConnecting} />
                      <small>Enter the permanent setup key shown when an authenticator app is enrolled—not the rotating six-digit code. Email verification cannot support unattended synchronization.</small>
                    </label>
                    <div className={styles.ebuyConsent}>
                      Connecting authorizes TAG CRM to retrieve the company&apos;s eligible eBuy opportunities and archive their attachments in the existing SharePoint site. It does not submit quotes or change eBuy data.
                    </div>
                    <div className={styles.ebuyTestActions}>
                      <button className="btn btn-primary" type="submit" disabled={ebuyConnecting || !integrationStatus?.ebuy?.connector?.connection?.encryptionConfigured || !['ready', 'error'].includes(integrationStatus?.ebuy?.status)}>
                        {ebuyConnecting ? 'Connecting…' : integrationStatus?.ebuy?.connector?.connection?.configured ? 'Replace connection' : 'Connect account'}
                      </button>
                      {showEbuyConnectionForm && <button className="btn" type="button" onClick={() => setShowEbuyConnectionForm(false)} disabled={ebuyConnecting}>Cancel</button>}
                    </div>
                  </form>
                )}

                {!integrationStatus?.ebuy?.connector?.connection?.encryptionConfigured && <p className={styles.setupNotice}>Add the EBUY_CREDENTIAL_ENCRYPTION_KEY Worker secret before entering company credentials.</p>}
                {integrationStatus?.ebuy?.status === 'migration_required' && <p className={styles.setupNotice}>Apply the latest D1 migration before connecting the account.</p>}

                {integrationStatus?.ebuy?.connector?.connection?.configured && !showEbuyConnectionForm && (
                  <>
                    <div className={styles.ebuyTestActions}>
                      <button className="btn btn-primary" type="button" onClick={handleEbuyLiveSync} disabled={ebuyLiveSyncing || integrationStatus?.ebuy?.lastSync?.status === 'running'}>{integrationStatus?.ebuy?.lastSync?.status === 'running' ? 'Synchronizing…' : ebuyLiveSyncing ? 'Starting…' : 'Synchronize now'}</button>
                      <button className="btn" type="button" onClick={handleEbuyConnectionTest} disabled={ebuyTestingConnection}>{ebuyTestingConnection ? 'Checking…' : 'Check connection'}</button>
                      <button className="btn" type="button" onClick={() => setShowEbuyConnectionForm(true)}>Replace credentials</button>
                      <button className="btn btn-danger" type="button" onClick={handleEbuyDisconnect} disabled={ebuyDisconnecting}>{ebuyDisconnecting ? 'Disconnecting…' : 'Disconnect'}</button>
                    </div>
                    <EbuySyncProgress run={integrationStatus?.ebuy?.lastSync} compact />
                  </>
                )}
              </div>

            </div>
          </div>}
        </div>

        <div className={styles.collapsible}>
          <button className={styles.collapsibleHeader} onClick={() => toggleSection('health')}>
            <span>
              <span className={styles.collapsibleTitle}>Automation health</span>
              <span className={styles.collapsibleHint}>Scheduled automations and integration checks</span>
            </span>
            <span className={`${styles.chevron} ${openSections.health ? styles.chevronOpen : ''}`}>›</span>
          </button>
          {openSections.health && (
            <div className={styles.healthBody}>
              {!integrationStatus?.automation?.length ? (
                <p className="text-xs text-muted" style={{ padding: '14px 18px' }}>
                  {integrationStatus?.capabilities?.status === 'auth_required'
                    ? 'Sign in again, then refresh status to load automation health.'
                    : 'Refresh status to load automation health.'}
                </p>
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

        <div className={styles.collapsible}>
          <button className={styles.collapsibleHeader} onClick={() => toggleSection('emailTemplates')}>
            <span>
              <span className={styles.collapsibleTitle}>Follow-up email templates</span>
              <span className={styles.collapsibleHint}>Editable schedules and content for user-approved drafts</span>
            </span>
            <span className={`${styles.chevron} ${openSections.emailTemplates ? styles.chevronOpen : ''}`}>›</span>
          </button>
          {openSections.emailTemplates && <FollowUpEmailTemplates user={user} toast={toast} />}
        </div>

        <div className={styles.collapsible}>
          <button className={styles.collapsibleHeader} onClick={() => toggleSection('folderMigration')}>
            <span>
              <span className={styles.collapsibleTitle}>SharePoint folder linking</span>
              <span className={styles.collapsibleHint}>Connect copied opportunity and partner folders to CRM records</span>
            </span>
            <span className={`${styles.chevron} ${openSections.folderMigration ? styles.chevronOpen : ''}`}>›</span>
          </button>
          {openSections.folderMigration && <LegacyFolderMigration toast={toast} />}
        </div>

        {/* ── Collapsible: Dropdown options ── */}
        <div className={styles.collapsible}>
          <button className={styles.collapsibleHeader} onClick={() => toggleSection('dropdowns')}>
            <span className={styles.collapsibleTitle}>Dropdown options</span>
            <span className={`${styles.chevron} ${openSections.dropdowns ? styles.chevronOpen : ''}`}>›</span>
          </button>
          {openSections.dropdowns && (
            <div className={styles.collapsibleBody}>
              {loading
                ? <div className="skeleton" style={{ height: 200 }} />
                : (
                  <div ref={dropdownScopeRef} className={styles.grid}>
                    {SECTIONS.map(({ key, label }) => {
                      const items = drafts[key] || []
                      const isLong = items.length > LONG_LIST_THRESHOLD
                      const isOpen = openLists[key] ?? !isLong   // long lists default closed, short ones default open
                      return (
                        <div key={key} className="card" onFocusCapture={() => setFocusedValidationKey(key)}>
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

        {/* ── Collapsible: SAM.gov opportunity discovery ── */}
        <div className={styles.collapsible} style={{ marginTop: 10 }}>
          <button className={styles.collapsibleHeader} onClick={() => toggleSection('sam')}>
            <span className={styles.collapsibleTitle}>SAM.gov opportunity discovery</span>
            <span className={`${styles.chevron} ${openSections.sam ? styles.chevronOpen : ''}`}>›</span>
          </button>
          {openSections.sam && (
            <div ref={samScopeRef} className={styles.collapsibleBody}>
              <p className="text-xs text-muted" style={{ marginBottom: 14 }}>
                Controls the pull of RFI, MRAS, RFP, and RFQ notices from SAM.gov.
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
                      NAICS codes {naicsCodes.length > LONG_LIST_THRESHOLD && <span className="text-xs text-muted">({naicsCodes.length})</span>}
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
                  <div className={styles.sectionLabel}>Response deadline window</div>
                  <div className={styles.itemList}>
                    <div className="form-field">
                        <label className="form-label">Minimum days before deadline</label>
                      <input className="form-input" type="number" min={0} max={30}
                        value={skipDays}
                        onChange={(e) => { setSkipDays(e.target.value); setSavedSAM(false) }} />
                      <span className="text-xs text-muted" style={{ marginTop: 3 }}>
                        Exclude opportunities with a deadline within this many days (avoids noise on imminent deadlines)
                      </span>
                    </div>
                    <div className="form-field" style={{ marginTop: 10 }}>
                        <label className="form-label">Maximum days before deadline</label>
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
                  <div className={styles.sectionLabel}>RFI, MRAS, and RFQ follow-on matching</div>
                  <p className="text-xs text-muted" style={{ margin: '4px 0 10px' }}>
                    Defaults for SAM.gov follow-on checks. Individual RFI, MRAS, or RFQ opportunities can override these rules.
                  </p>
                  <div className={styles.itemList}>
                    <label className="text-sm" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <input type="checkbox" checked={rfiFollowUp.monitoringEnabled}
                        onChange={(e) => { setRfiFollowUp((prev) => ({ ...prev, monitoringEnabled: e.target.checked })); setSavedSAM(false) }} />
                      Monitor RFI, MRAS, and RFQ opportunities for RFP or RFQ follow-ons
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
                      <label className="form-label">Follow-on notice types</label>
                      <input className="form-input" value="RFP or RFQ" readOnly aria-readonly="true" />
                      <span className="text-xs text-muted" style={{ marginTop: 3 }}>Both procurement paths are checked.</span>
                    </div>
                    <div className="form-field" style={{ marginTop: 8 }}>
                      <label className="form-label">Search period after submission (days)</label>
                      <input className="form-input" type="number" min={1} max={364} value={rfiFollowUp.submissionWindowDays}
                        onChange={(e) => { setRfiFollowUp((prev) => ({ ...prev, submissionWindowDays: e.target.value })); setSavedSAM(false) }} />
                    </div>
                    <div className="form-field" style={{ marginTop: 8 }}>
                      <label className="form-label">Fallback search period</label>
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
                title="Pull SAM.gov opportunities now">
                {triggering ? '⏳ Running…' : '▶ Pull opportunities now'}
              </button>
              {triggerResult && (
                <span style={{ fontSize: 12, color: triggerResult.ok ? 'var(--green-600)' : 'var(--red-600)' }}>
                  {triggerResult.ok ? '✓ ' : '✗ '}{triggerResult.message}
                </span>
              )}
            </div>
            <button className="btn btn-primary" onClick={handleSaveSAM} disabled={savingSAM}>
              {savingSAM ? 'Saving…' : savedSAM ? '✓ Saved' : 'Save discovery settings'}
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
                and a warning banner will appear on the SAM tab.<br />
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
