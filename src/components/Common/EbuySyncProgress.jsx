import styles from './EbuySyncProgress.module.css'

export default function EbuySyncProgress({ run, compact = false }) {
  if (run?.status !== 'running') return null
  const progress = run.progress || run.details?.progress || {}
  const percent = Math.max(1, Math.min(99, Number(progress.percent || 2)))
  const processed = Number(progress.processed || 0)
  const total = Number(progress.total || 0)
  const discovered = Number(run.discovered_count || 0)
  const archivedFiles = Number(progress.archivedFiles ?? run.archived_file_count ?? 0)

  return (
    <div className={`${styles.progress} ${compact ? styles.compact : ''}`} aria-live="polite">
      <div className={styles.heading}>
        <strong>{progress.message || 'Synchronizing GSA eBuy opportunities'}</strong>
        <span>{Math.round(percent)}%</span>
      </div>
      <div
        className={styles.track}
        role="progressbar"
        aria-label="GSA eBuy synchronization progress"
        aria-valuemin="0"
        aria-valuemax="100"
        aria-valuenow={Math.round(percent)}
      >
        <span style={{ width: `${percent}%` }} />
      </div>
      {!compact && <div className={styles.meta}>
        <span>{discovered} found</span>
        {total > 0 && <span>{processed} of {total} processed</span>}
        <span>{archivedFiles} files archived</span>
      </div>}
    </div>
  )
}
