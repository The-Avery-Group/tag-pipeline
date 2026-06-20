import { useState, useEffect } from 'react'
import Topbar from '@/components/Layout/Topbar'
import { useValidationLists } from '@/hooks/useValidationLists'
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

export default function Settings({ toast }) {
  const { lists, loading, update } = useValidationLists()
  const [drafts, setDrafts] = useState({})
  const [savingKey, setSavingKey] = useState(null)
  const [savedKey, setSavedKey] = useState(null)

  // ── SAM config state ─────────────────────────────────────────────────
  const [naicsCodes,    setNaicsCodes]    = useState([])
  const [skipDays,      setSkipDays]      = useState(3)
  const [windowDays,    setWindowDays]    = useState(90)
  const [samLoaded,     setSamLoaded]     = useState(false)
  const [savingSAM,     setSavingSAM]     = useState(false)
  const [savedSAM,      setSavedSAM]      = useState(false)
  const [triggering,    setTriggering]    = useState(false)
  const [triggerResult, setTriggerResult] = useState(null)

  useEffect(() => {
    Promise.all([getSAMNAICS(), getSAMSettings()]).then(([codes, settings]) => {
      setNaicsCodes(codes)
      setSkipDays(settings.skipDays)
      setWindowDays(settings.windowDays)
      setSamLoaded(true)
    }).catch((err) => {
      console.warn('[Settings] Failed to load SAM config:', err.message)
      setSamLoaded(true)
    })
  }, [])

  const handleSaveSAM = async () => {
    setSavingSAM(true)
    setSavedSAM(false)
    try {
      const cleanedCodes = naicsCodes.map((c) => String(c).trim()).filter(Boolean)
      await Promise.all([
        updateSAMNAICS(cleanedCodes),
        updateSAMSettings(Number(skipDays), Number(windowDays)),
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
    const workerUrl = import.meta.env.VITE_API_BASE_URL
    const secret    = import.meta.env.VITE_SAM_TRIGGER_SECRET
    if (!workerUrl || !secret) {
      toast?.error('VITE_API_BASE_URL or VITE_SAM_TRIGGER_SECRET not set')
      return
    }
    setTriggering(true)
    setTriggerResult(null)
    try {
      const res = await fetch(`${workerUrl}/sam/trigger`, {
        method: 'POST',
        headers: { 'X-Trigger-Secret': secret },
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || `Worker returned ${res.status}`)
      setTriggerResult({ ok: true, message: data.message })
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
        {loading
          ? <div className="skeleton" style={{ height: 200 }} />
          : (
            <div className={styles.grid}>
              {SECTIONS.map(({ key, label }) => (
                <div key={key} className="card">
                  <div className={styles.sectionLabel}>{label}</div>
                  <div className={styles.itemList}>
                    {(drafts[key] || []).map((val, i) => (
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
                </div>
              ))}
            </div>
          )
        }
        <p className="text-xs text-muted">
          These options are shared across all users and stored on the Data Validation sheet of the workbook.
          Task statuses and task priorities are fixed and not configurable here.
        </p>

        {/* ── SAM.gov API settings ── */}
        <div style={{ marginTop: 28 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--gray-900)', marginBottom: 4 }}>
            SAM.gov API
          </div>
          <p className="text-xs text-muted" style={{ marginBottom: 14 }}>
            Controls the nightly pull of Sources Sought opportunities from SAM.gov.
            Changes take effect on the next scheduled run (3 AM EST).
          </p>

          {!samLoaded
            ? <div className="skeleton" style={{ height: 120 }} />
            : (
              <div className={styles.grid}>
                {/* NAICS codes */}
                <div className="card">
                  <div className={styles.sectionLabel}>NAICS Codes</div>
                  <div className={styles.itemList}>
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
              </div>
            )
          }

          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <button className="btn" onClick={handleTriggerSAM} disabled={triggering}
                title="Manually run the SAM.gov pull now without waiting for the nightly cron">
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
            marginTop: 16, padding: '12px 14px',
            background: 'var(--gray-50)', border: '0.5px solid var(--gray-200)',
            borderRadius: 'var(--radius-md)', fontSize: 12, color: 'var(--gray-600)', lineHeight: 1.6,
          }}>
            <strong style={{ color: 'var(--gray-900)' }}>API key rotation</strong><br />
            SAM.gov public API keys expire every 90 days. When yours expires, the nightly pull will stop
            and a warning banner will appear on the New Opportunities tab.<br />
            To rotate: run <code style={{ background: 'var(--gray-200)', padding: '1px 5px', borderRadius: 3 }}>wrangler secret put SAM_API_KEY</code> in your terminal, paste your new key, and deploy.
            No code changes required.
          </div>
        </div>
      </div>
    </>
  )
}
