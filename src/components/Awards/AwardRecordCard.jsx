import styles from './AwardRecordCard.module.css'

// Human-readable labels for the Worker's extracted field keys — kept here
// (not on the Worker) since it's purely a display concern.
const FIELD_LABELS = {
  totalContractValue:    'Total Contract Value',
  contractEndDate:       'Contract End Date',
  fiscalYear:            'Fiscal Year',
  naicsCode:             'NAICS Code',
  department:            'Department',
  agency:                'Agency',
  office:                'Office',
  solicitationNumber:    'Solicitation Number',
  setAside:              'Set-Aside',
  incumbentName:         'Incumbent (Company)',
  incumbentUEI:          'Incumbent (UEI)',
  contractVehicleNumber: 'Contract Vehicle Number',
}

function formatFieldValue(key, value) {
  if (value == null || value === '') return '—'
  if (key === 'totalContractValue') {
    const n = Number(value)
    return isNaN(n) ? String(value) : `$${n.toLocaleString('en-US')}`
  }
  if (key === 'contractEndDate') {
    const d = new Date(value)
    return isNaN(d.getTime()) ? String(value) : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
  }
  return String(value)
}

/**
 * AwardRecordCard
 *
 * Pure presentational display of one composite award record (already
 * merged across its modification history by the Worker). Has no idea how
 * to write data anywhere — the optional renderFieldAction render-prop is
 * how a consumer (OpportunityDetail's per-field "update pipeline" buttons)
 * hooks in its own write behavior, without this component needing to know
 * about PipelineTable, usePipeline, or anything CRM-specific. Used without
 * that prop by the Lookup tab, which only needs a single whole-record
 * "add to pipeline" action instead.
 *
 * @param result - one entry from useAwardsLookup's `results` array:
 *   { raw, fields, modificationCount, latestModificationNumber, matchedBy }
 * @param renderFieldAction - optional (fieldKey, field) => ReactNode
 */
export default function AwardRecordCard({ result, renderFieldAction }) {
  const { raw, fields, modificationCount, latestModificationNumber } = result
  const piid = raw?.contractId?.piid
  const isIDV = raw?.coreData?.awardOrIDV === 'IDV'

  const visibleFields = Object.entries(fields || {}).filter(([, field]) => field.value != null && field.value !== '')

  return (
    <div className="card" style={{ marginBottom: 10 }}>
      <div className={styles.cardHeader}>
        <div>
          <div className={styles.piid}>{piid || 'Unknown PIID'}</div>
          <div className={styles.recordType}>{isIDV ? 'Contract Vehicle (IDV)' : 'Definitive Contract / Order'}</div>
        </div>
        {modificationCount > 1 && (
          <div className={styles.modBadge} title="Modification history was merged into this view">
            {modificationCount} modifications
            {latestModificationNumber && ` · current as of ${latestModificationNumber}`}
          </div>
        )}
      </div>

      {visibleFields.length === 0
        ? <p className="text-sm text-muted">No usable field data on this record.</p>
        : (
          <div className={styles.fieldGrid}>
            {visibleFields.map(([key, field]) => (
              <div key={key} className={styles.fieldRow}>
                <div className={styles.fieldLabel}>{FIELD_LABELS[key] || key}</div>
                <div className={styles.fieldValueRow}>
                  <span className={styles.fieldValue} title={formatFieldValue(key, field.value)}>
                    {formatFieldValue(key, field.value)}
                  </span>
                  {renderFieldAction?.(key, field)}
                </div>
              </div>
            ))}
          </div>
        )
      }
    </div>
  )
}
