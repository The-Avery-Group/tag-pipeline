import { useEffect, useRef, useState } from 'react'
import { normalizeSAMNoticeType } from '@/utils/samOpportunityHelpers'
import styles from './DiscoveryToolbar.module.css'

export const DISCOVERY_TYPE_OPTIONS = [
  { value: 'RFI_MRAS', label: 'RFIs and MRAS' },
  { value: 'RFI', label: 'RFIs only' },
  { value: 'MRAS', label: 'MRAS only' },
  { value: 'RFP', label: 'RFPs' },
  { value: 'RFQ', label: 'RFQs' },
  { value: 'All', label: 'All types' },
]

export function readStoredDiscoveryType(storageKey, fallback) {
  try {
    const stored = localStorage.getItem(storageKey)
    return DISCOVERY_TYPE_OPTIONS.some((option) => option.value === stored) ? stored : fallback
  } catch { return fallback }
}

export function DiscoveryTypeBadge({ type }) {
  const normalized = normalizeSAMNoticeType(type)
  const label = normalized || String(type || '').trim() || 'Other'
  return <span data-notice-type={normalized || 'Other'} className={`${styles.typeBadge} ${styles[`type${normalized || 'Other'}`]}`}>{label}</span>
}

function AgencyFilter({ agencies, selected, onToggle, onClear }) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef(null)

  useEffect(() => {
    if (!open) return undefined
    const close = (event) => {
      if (!rootRef.current?.contains(event.target)) setOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])

  return <div className={styles.agencyFilter} ref={rootRef}>
    <button
      type="button"
      className={styles.agencyButton}
      onClick={() => setOpen((value) => !value)}
      aria-expanded={open}
      title="Filter by agency"
    >🏛 Agency{selected.size > 0 ? ` (${selected.size})` : ''}</button>
    {open && <div className={styles.agencyMenu}>
      <div className={styles.agencyHeading}>
        <span>Filter by agency</span>
        {selected.size > 0 && <button type="button" onClick={onClear}>Clear</button>}
      </div>
      {agencies.length > 0
        ? agencies.map((agency) => <label key={agency} className={styles.agencyOption}>
          <input type="checkbox" checked={selected.has(agency)} onChange={() => onToggle(agency)} />
          <span>{agency}</span>
        </label>)
        : <span className={styles.agencyEmpty}>No agencies available</span>}
    </div>}
  </div>
}

export default function DiscoveryToolbar({
  count,
  type,
  onTypeChange,
  agencies = [],
  selectedAgencies = new Set(),
  onAgencyToggle,
  onAgencyClear,
  status,
  controlsOpen,
  onControlsToggle,
  selectionMode,
  onSelectionToggle,
  selectionDisabled = false,
  children,
}) {
  return <div className={styles.toolbar}>
    <div className={styles.filters}>
      <span className={styles.count}>{count} opportunit{count === 1 ? 'y' : 'ies'}</span>
      <label className={styles.typeFilter}>
        <span>Type</span>
        <select value={type} onChange={(event) => onTypeChange(event.target.value)}>
          {DISCOVERY_TYPE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
      </label>
      <AgencyFilter
        agencies={agencies}
        selected={selectedAgencies}
        onToggle={onAgencyToggle}
        onClear={onAgencyClear}
      />
      {controlsOpen && <div className={styles.manualControls}>{children}</div>}
    </div>
    <div className={styles.statusArea}>
      <span className={styles.status}>{status}</span>
      <button
        type="button"
        className={`${styles.controlButton} ${controlsOpen ? styles.controlButtonActive : ''}`}
        onClick={onControlsToggle}
        aria-expanded={controlsOpen}
        title={controlsOpen ? 'Hide synchronization controls' : 'Show synchronization controls'}
      >Controls</button>
      <button type="button" className={styles.controlButton} onClick={onSelectionToggle} disabled={selectionDisabled}>
        {selectionMode ? 'Cancel' : 'Select'}
      </button>
    </div>
  </div>
}

export function DiscoverySelectionBar({ count, children }) {
  return <div className={styles.selectionBar}>
    <span><strong>{count}</strong> selected</span>
    <div>{children}</div>
  </div>
}
