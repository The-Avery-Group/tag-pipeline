import styles from './AwardRecordCard.module.css'

const SECTION_ORDER = [
  'Contract identity', 'Contract status', 'Contract snapshot', 'Agency and scope',
  'Latest modification', 'Modification details', 'Award notice',
]

const LIFECYCLE_REASON_PATTERN = /\b(?:terminat(?:e|ed|ion)|cancel(?:led|lation)?|close[ -]?out)\b/i

function isLifecycleReason(item) {
  return Boolean(item?.lifecycleAlert) || LIFECYCLE_REASON_PATTERN.test(String(item?.value || ''))
}

function formatFieldValue(field, value) {
  if (value == null || value === '') return 'Not provided'
  if (field.format === 'currency') {
    const number = Number(value)
    return Number.isNaN(number) ? String(value) : `$${number.toLocaleString('en-US', { maximumFractionDigits: 2 })}`
  }
  if (field.format === 'date') {
    const date = new Date(value)
    return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
  }
  return String(value)
}

function formatCacheTime(value) {
  if (!value) return ''
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true })
}

export default function AwardRecordCard({
  piid, isIDV, modificationCount, originalSignedDate, samLink,
  cache, fields, contractLifecycleAlert, renderFieldAction, onRefresh, refreshing,
}) {
  const directReasonIsLifecycleAlert = isLifecycleReason(fields?.reasonForModification)
  const displayFields = {
    ...(fields || {}),
    // The latest transaction may be an administrative change after a
    // termination or close-out. Keep the active lifecycle reason visible in
    // that case, instead of making users infer it only from the page badge.
    ...(!directReasonIsLifecycleAlert && contractLifecycleAlert?.reason
      ? {
          contractLifecycleReason: {
            section: 'Contract status',
            label: 'Reason for modification',
            value: contractLifecycleAlert.reason,
            fullWidth: true,
            lifecycleAlert: true,
          },
        }
      : {}),
  }
  const visibleFields = Object.entries(displayFields).filter(([, item]) => item.value != null && item.value !== '')
  const bySection = {}
  for (const [key, item] of visibleFields) {
    const section = item.section || 'Other'
    if (!bySection[section]) bySection[section] = []
    bySection[section].push([key, item])
  }
  const sections = SECTION_ORDER.filter((section) => bySection[section]?.length)
  const cacheLabel = cache?.source === 'cache' ? 'Cached SAM data' : cache?.source === 'live' ? 'Live SAM data' : null

  return (
    <article className={`card ${styles.recordCard}`}>
      <header className={styles.cardHeader}>
        <div>
          <div className={styles.eyebrow}>Contract award record</div>
          <h3 className={styles.piid}>{piid || 'Unknown PIID'}</h3>
          <p className={styles.recordType}>
            {isIDV ? 'Contract vehicle (IDV)' : 'Definitive contract or order'}
            {originalSignedDate && ` · originally signed ${formatFieldValue({ format: 'date' }, originalSignedDate)}`}
          </p>
        </div>
        <div className={styles.headerActions}>
          {cacheLabel && <span className={styles.cacheBadge} title={formatCacheTime(cache?.fetchedAt)}>{cacheLabel}</span>}
          {modificationCount > 1 && <span className={styles.modBadge}>{modificationCount} award transactions</span>}
          {onRefresh && (
            <button type="button" className={styles.refreshButton} onClick={onRefresh} disabled={refreshing}>
              {refreshing ? 'Refreshing…' : 'Refresh from SAM.gov'}
            </button>
          )}
          {samLink && <a href={samLink} target="_blank" rel="noreferrer" className={styles.samLink}>View contract on SAM.gov ↗</a>}
        </div>
      </header>

      {sections.length === 0
        ? <p className="text-sm text-muted">No usable field data on this record.</p>
        : sections.map((section) => (
          <section key={section} className={styles.section}>
            <h4 className={styles.sectionHeader}>{section}</h4>
            <div className={styles.fieldGrid}>
              {bySection[section].map(([key, item]) => {
                const lifecycleReason = isLifecycleReason(item)
                return (
                <div key={key} className={`${styles.fieldRow} ${item.fullWidth ? styles.fullWidth : ''} ${lifecycleReason ? styles.lifecycleField : ''}`}>
                  <div className={styles.fieldLabel} title={item.helpText || ''}>{item.label || key}</div>
                  <div className={styles.fieldValueRow}>
                    {item.format === 'link'
                      ? <a href={item.value} target="_blank" rel="noreferrer" className={styles.inlineLink}>Open award notice ↗</a>
                      : <span className={`${styles.fieldValue} ${lifecycleReason ? styles.lifecycleValue : ''}`} title={formatFieldValue(item, item.value)}>{formatFieldValue(item, item.value)}</span>}
                    {renderFieldAction?.(key, item)}
                  </div>
                  {item.provenance?.lastModifiedDate && (
                    <div className={styles.provenance}>SAM transaction updated {formatFieldValue({ format: 'date' }, item.provenance.lastModifiedDate)}</div>
                  )}
                </div>
                )
              })}
            </div>
          </section>
        ))}
    </article>
  )
}
