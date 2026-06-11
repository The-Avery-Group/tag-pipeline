import { useState } from 'react'
import Topbar from '@/components/Layout/Topbar'
import styles from './Settings.module.css'

// Default values — in a real app these would be persisted to a settings sheet
const DEFAULTS = {
  opportunityPhases: ['Research', 'Indentified', 'Contract Awarded'],
  activityPhases: ['Pre-RFP', 'Submitted RFI', 'RFP Released', 'Proposal Submitted', 'BAFO', 'Award Pending'],
  outlooks: ['Expiring', 'Forecasted', 'New'],
  priorities: ['Cold', 'Warm', 'Hot'],
  taskStatuses: ['To Do', 'In Progress', 'Done'],
  taskPriorities: ['Low', 'Medium', 'High'],
  setAsides: ['-', '8A', '8AN', 'NONE', 'SBA', 'SDVOSBC', 'SDVOSBS'],
  primeOrSub: ['Prime', 'Sub'],
  bidNoBid: ['Bid', 'No Bid', 'TBD'],
}

// Persist to localStorage so values survive page reload
function loadSettings() {
  try {
    const saved = localStorage.getItem('tag_settings')
    return saved ? { ...DEFAULTS, ...JSON.parse(saved) } : { ...DEFAULTS }
  } catch {
    return { ...DEFAULTS }
  }
}

export function saveSettings(settings) {
  localStorage.setItem('tag_settings', JSON.stringify(settings))
}

export function useSettings() {
  return loadSettings()
}

export default function Settings({ toast }) {
  const [settings, setSettings] = useState(loadSettings)
  const [saved, setSaved] = useState(false)

  const updateList = (key, index, value) => {
    const list = [...settings[key]]
    list[index] = value
    setSettings({ ...settings, [key]: list })
    setSaved(false)
  }

  const addItem = (key) => {
    setSettings({ ...settings, [key]: [...settings[key], ''] })
    setSaved(false)
  }

  const removeItem = (key, index) => {
    const list = settings[key].filter((_, i) => i !== index)
    setSettings({ ...settings, [key]: list })
    setSaved(false)
  }

  const handleSave = () => {
    // Remove blank entries before saving
    const cleaned = {}
    Object.entries(settings).forEach(([k, v]) => {
      cleaned[k] = v.filter((s) => s.trim() !== '')
    })
    saveSettings(cleaned)
    setSettings(cleaned)
    setSaved(true)
    toast?.success('Settings saved')
  }

  const SECTIONS = [
    { key: 'opportunityPhases',  label: 'Opportunity Phases (TAG Phase)' },
    { key: 'activityPhases',     label: 'Activity Phases (Pipeline Activity)' },
    { key: 'outlooks',           label: 'Opportunity Outlooks' },
    { key: 'priorities',         label: 'Priority Values' },
    { key: 'taskStatuses',       label: 'Task Statuses' },
    { key: 'taskPriorities',     label: 'Task Priorities' },
    { key: 'setAsides',          label: 'Set-Aside Values' },
    { key: 'primeOrSub',         label: 'Prime or Sub Options' },
    { key: 'bidNoBid',           label: 'Bid / No Bid Options' },
  ]

  return (
    <>
      <Topbar
        title="Settings"
        subtitle1="Manage dropdown options and app configuration"
        showFilter={false}
        showNew={false}
      />
      <div className="page-body">
        <div className={styles.grid}>
          {SECTIONS.map(({ key, label }) => (
            <div key={key} className="card">
              <div className={styles.sectionLabel}>{label}</div>
              <div className={styles.itemList}>
                {settings[key].map((val, i) => (
                  <div key={i} className={styles.itemRow}>
                    <input
                      className="form-input"
                      value={val}
                      onChange={(e) => updateList(key, i, e.target.value)}
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
              <button className={styles.addBtn} onClick={() => addItem(key)}>
                + Add option
              </button>
            </div>
          ))}
        </div>

        <div className={styles.saveRow}>
          <button className="btn btn-primary" onClick={handleSave}>
            {saved ? '✓ Saved' : 'Save settings'}
          </button>
          <span className="text-xs text-muted">
            Settings are stored locally in your browser.
          </span>
        </div>
      </div>
    </>
  )
}