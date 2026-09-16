import { useState, useSyncExternalStore } from 'react'
import { Link } from 'react-router-dom'
import Modal from '@/components/Common/Modal'
import { partnerRefreshQueue } from '@/utils/partnerGroups'
import styles from './Topbar.module.css'

export default function Topbar({
  title, subtitle1, subtitle2,
  showFilter, showNew, newLabel = 'New',
  onFilter, onNew, greetingLarge = false, rightContent,
}) {
  const [filterActive, setFilterActive] = useState(false)
  const [queueOpen, setQueueOpen] = useState(false)
  const jobs = useSyncExternalStore(partnerRefreshQueue.subscribe, partnerRefreshQueue.getSnapshot)
  const activeJob = jobs.find(job => job.status === 'running')
  const waiting = jobs.filter(job => job.status === 'queued').length
  const failed = jobs.filter(job => job.status === 'failed').length
  const queueStatus = activeJob ? `Updating ${activeJob.name}` : waiting ? 'Partner updates queued' : 'Partner updates finished'
  const queueCounts = [waiting > 0 && `${waiting} queued`, failed > 0 && `${failed} failed`].filter(Boolean).join(' · ')

  const handleFilter = () => {
    setFilterActive((v) => !v)
    onFilter?.()
  }

  return (
    <header className={styles.topbar}>
      <div className={styles.left}>
        <div className={`${styles.title} ${greetingLarge ? styles.titleLarge : ''}`}>{title}</div>
        <div className={styles.subRow}>
          {subtitle1 && <div className={styles.sub}>{subtitle1}</div>}
          {subtitle2 && <><span className={styles.subDot}>·</span><div className={styles.sub}>{subtitle2}</div></>}
        </div>
      </div>
      <div className={styles.actions}>
        {jobs.length > 0 && <button className={`btn ${styles.queueButton}`} onClick={() => setQueueOpen(true)} title={[queueStatus, queueCounts].filter(Boolean).join(' · ')} aria-label={`Open partner refresh queue: ${queueStatus}${queueCounts ? `, ${queueCounts}` : ''}`}>
          <span className={styles.queueStatus}>{queueStatus}</span>
          {queueCounts && <span className={styles.queueCounts}>{queueCounts}</span>}
        </button>}
        {rightContent}
        {showFilter && (
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
        )}
        {showNew && (
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
        )}
      </div>
      {queueOpen && <Modal title="Partner refresh queue" onClose={() => setQueueOpen(false)}>
        <p className={styles.queueHelp}>Updates continue as you move around the CRM. Closing or reloading this browser tab interrupts the queue.</p>
        <p className={styles.queueHelp}>You can remove waiting updates. The update currently running will finish safely.</p>
        <ul className={styles.queueList}>{jobs.map(job => <li key={job.partnerId || job.uei}>
          <Link to={`/partners?partner=${encodeURIComponent(job.partnerId || job.uei)}`} onClick={() => setQueueOpen(false)}>{job.name}</Link>
          <span>{job.status === 'queued' ? 'Queued' : job.status === 'failed' ? job.error : job.progress}</span>
          {job.status === 'queued' && <button className="btn text-sm" onClick={() => partnerRefreshQueue.remove(job.partnerId || job.uei)}>Remove from queue</button>}
          {job.status === 'failed' && <button className="btn text-sm" onClick={() => {
            import('@/services/partnerWorkspaceService').then(module => module.refreshPartnerEnrichment(job.uei, { name: job.name, partnerId: job.partnerId })).catch(() => {})
          }}>Retry</button>}
        </li>)}</ul>
        {waiting > 0 && <button className="btn text-sm" onClick={() => partnerRefreshQueue.removeWaiting()}>Remove all waiting</button>}
        <button className="btn text-sm" onClick={() => { partnerRefreshQueue.clearFinished(); if (!activeJob && !waiting) setQueueOpen(false) }}>Clear finished results</button>
      </Modal>}
    </header>
  )
}
