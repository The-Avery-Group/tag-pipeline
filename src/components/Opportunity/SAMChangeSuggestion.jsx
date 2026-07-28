import { useState } from 'react'
import styles from '@/pages/OpportunityDetail.module.css'

function label(column) {
  return String(column || '')
    .replace(/\*$/, '')
    .replace(/\s*\([^)]*\)\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function display(value) {
  return String(value || '').trim() || 'Not set'
}

export default function SAMChangeSuggestion({
  suggestion,
  applying,
  onApply,
  onKeepCurrent,
}) {
  const [expanded, setExpanded] = useState(false)
  if (!suggestion) return null

  const changes = suggestion?.changes || []
  return (
    <div className={styles.samSuggestion}>
      <div className={styles.samSuggestionSummary}>
        <div>
          <strong>SAM.gov has newer information for this opportunity</strong>
          <span>
            {changes.length
              ? `${changes.length} pipeline field${changes.length === 1 ? '' : 's'} can be updated.`
              : 'The notice changed, but no mapped pipeline fields need replacing.'}
          </span>
        </div>
        <div className={styles.samSuggestionActions}>
          {changes.length > 0 && (
            <button className="btn text-xs" type="button" onClick={() => setExpanded((value) => !value)}>
              {expanded ? 'Hide changes' : 'Review changes'}
            </button>
          )}
          {changes.length === 0 && (
            <button className="btn text-xs" type="button" disabled={applying} onClick={onKeepCurrent}>Mark reviewed</button>
          )}
          {suggestion?.watch?.change?.uiLink && (
            <a className="btn text-xs" href={suggestion.watch.change.uiLink} target="_blank" rel="noreferrer">View on SAM.gov</a>
          )}
        </div>
      </div>

      {expanded && changes.length > 0 && (
        <div className={styles.samSuggestionTableWrap}>
          <table className={styles.samSuggestionTable}>
            <thead><tr><th>Field</th><th>Current pipeline value</th><th>Latest SAM.gov value</th></tr></thead>
            <tbody>
              {changes.map((change) => (
                <tr key={change.column}>
                  <td>{label(change.column)}</td>
                  <td>{display(change.current)}</td>
                  <td>{display(change.next)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className={styles.samSuggestionFooter}>
            <button className="btn text-xs" type="button" disabled={applying} onClick={onKeepCurrent}>Keep current values</button>
            <button className="btn btn-primary text-xs" type="button" disabled={applying} onClick={onApply}>
              {applying ? 'Updating…' : 'Update pipeline'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
