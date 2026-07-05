import styles from './AwardRecordCard.module.css'

// Section display order — the Worker embeds section/label directly on each
// field now (see extractCurrentStateFields/extractTransactionFields in
// awards.js), so this component just groups and orders rather than
// maintaining its own duplicate label map.
const SECTION_ORDER = [
  'Summary', 'Modification Details', 'Performance', 'Solicitation',
  'Description', 'Contract Details', 'History',
]

function formatFieldValue(key, value) {
  if (value == null || value === '') return '—'
  if (key === 'totalEstimatedOrderValue') {
    const n = Number(value)
    return isNaN(n) ? String(value) : `$${n.toLocaleString('en-US')}`
  }
  if (/date/i.test(key)) {
    const d = new Date(value)
    return isNaN(d.getTime()) ? String(value) : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
  }
  return String(value)
}

/**
 * AwardRecordCard
 *
 * Pure presentational display of one award record's field set — grouped
 * into sections (Summary, Modification Details, Performance, Solicitation,
 * Description, Contract Details, History) with a preserved 2-column field
 * grid and hover-revealed per-field action buttons, same look as before.
 *
 * Has no idea how to write data anywhere, and no idea about modification
 * history/toggling — the caller decides which fields to pass in (e.g.
 * OpportunityDetail passes the merged "current" view; the Lookup page
 * passes whichever modification snapshot is currently selected).
 *
 * @param piid, isIDV, modificationCount, originalSignedDate, samLink — header info
 * @param fields - flat field-key → { section, label, value, column } map
 * @param renderFieldAction - optional (fieldKey, field) => ReactNode
 */
export default function AwardRecordCard({
  piid, isIDV, modificationCount, originalSignedDate, samLink,
  fields, renderFieldAction,
}) {
  const visibleFields = Object.entries(fields || {}).filter(([, field]) => field.value != null && field.value !== '')

  const bySection = {}
  for (const [key, field] of visibleFields) {
    const section = field.section || 'Other'
    if (!bySection[section]) bySection[section] = []
    bySection[section].push([key, field])
  }
  const sections = SECTION_ORDER.filter((s) => bySection[s]?.length)

  return (
    <div className="card" style={{ marginBottom: 10 }}>
      <div className={styles.cardHeader}>
        <div>
          <div className={styles.piid}>{piid || 'Unknown PIID'}</div>
          <div className={styles.recordType}>
            {isIDV ? 'Contract Vehicle (IDV)' : 'Definitive Contract / Order'}
            {originalSignedDate && ` · originally signed ${formatFieldValue('date', originalSignedDate)}`}
          </div>
        </div>
        <div style={{ textAlign: 'right' }}>
          {modificationCount > 1 && (
            <div className={styles.modBadge} title="Modification history was merged into this view">
              {modificationCount} modifications
            </div>
          )}
          {samLink && (
            <a href={samLink} target="_blank" rel="noreferrer" className={styles.samLink}>
              View on SAM.gov ↗
            </a>
          )}
        </div>
      </div>

      {sections.length === 0
        ? <p className="text-sm text-muted">No usable field data on this record.</p>
        : sections.map((section) => (
          <div key={section}>
            <div className={styles.sectionHeader}>{section}</div>
            <div className={styles.fieldGrid}>
              {bySection[section].map(([key, field]) => (
                <div key={key} className={styles.fieldRow}>
                  <div className={styles.fieldLabel}>{field.label || key}</div>
                  <div className={styles.fieldValueRow}>
                    <span className={styles.fieldValue} title={formatFieldValue(key, field.value)}>
                      {formatFieldValue(key, field.value)}
                    </span>
                    {renderFieldAction?.(key, field)}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))
      }
    </div>
  )
}
