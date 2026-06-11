import { useState } from 'react'
import styles from './Topbar.module.css'

export default function Topbar({ title, subtitle1, subtitle2, showFilter, showNew, newLabel = 'New', onFilter, onNew }) {
  const [filterActive, setFilterActive] = useState(false)

  const handleFilter = () => {
    setFilterActive((v) => !v)
    onFilter?.()
  }

  return (
    <header className={styles.topbar}>
      <div className={styles.left}>
        <div className={styles.title}>{title}</div>
        {subtitle1 && <div className={styles.sub}>{subtitle1}</div>}
        {subtitle2 && <div className={styles.sub}>{subtitle2}</div>}
      </div>
      <div className={styles.actions}>
        {showFilter && (
          <div className={styles.tipWrap}>
            <button
              className={`${styles.iconBtn} ${filterActive ? styles.iconBtnActive : ''}`}
              onClick={handleFilter}
              aria-label="Filter"
              title="Filter"
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/>
              </svg>
            </button>
          </div>
        )}
        {showNew && (
          <div className={styles.tipWrap}>
            <button
              className={`${styles.iconBtn} ${styles.iconBtnPrimary}`}
              onClick={onNew}
              aria-label={newLabel}
              title={newLabel}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
              </svg>
            </button>
            <span className={styles.tooltip}>{newLabel}</span>
          </div>
        )}
      </div>
    </header>
  )
}
