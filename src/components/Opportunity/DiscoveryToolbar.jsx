import { useEffect, useRef, useState } from 'react'
import styles from './DiscoveryToolbar.module.css'

export const DISCOVERY_TYPE_OPTIONS = [
  { value: 'RFI_MRAS', label: 'RFIs and MRAS' },
  { value: 'RFI', label: 'RFIs only' },
  { value: 'MRAS', label: 'MRAS only' },
  { value: 'RFP', label: 'RFPs' },
  { value: 'RFQ', label: 'RFQs' },
  { value: 'All', label: 'All types' },
]

function DepartmentFilter({ departments, selected, onToggle, onClear }) {
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

  return <div className={styles.department} ref={rootRef}>
    <button
      type="button"
      className={styles.departmentButton}
      onClick={() => setOpen((value) => !value)}
      aria-expanded={open}
      title="Filter by department"
    >🏛 Dept{selected.size > 0 ? ` (${selected.size})` : ''}</button>
    {open && <div className={styles.departmentMenu}>
      <div className={styles.departmentHeading}>
        <span>Filter by department</span>
        {selected.size > 0 && <button type="button" onClick={onClear}>Clear</button>}
      </div>
      {departments.length > 0
        ? departments.map((department) => <label key={department} className={styles.departmentOption}>
          <input type="checkbox" checked={selected.has(department)} onChange={() => onToggle(department)} />
          <span>{department}</span>
        </label>)
        : <span className={styles.departmentEmpty}>No departments available</span>}
    </div>}
  </div>
}

export default function DiscoveryToolbar({
  count,
  type,
  onTypeChange,
  departments = [],
  selectedDepartments = new Set(),
  onDepartmentToggle,
  onDepartmentClear,
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
      <DepartmentFilter
        departments={departments}
        selected={selectedDepartments}
        onToggle={onDepartmentToggle}
        onClear={onDepartmentClear}
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
