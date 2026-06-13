import { useState, useEffect } from 'react'
import Topbar from '@/components/Layout/Topbar'
import { useValidationLists } from '@/hooks/useValidationLists'
import {
  VALIDATION_KEY_MAP,
  OPPORTUNITY_PHASES, OPPORTUNITY_OUTLOOK, PRIORITY_VALUES,
  SET_ASIDE_VALUES, CONTACT_TYPES,
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
      </div>
    </>
  )
}
