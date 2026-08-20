import styles from '@/pages/OpportunityDetail.module.css'
import CopyValue from '@/components/Common/CopyValue'

export default function OpportunityField({ label, value, editing, onChange, type = 'text', options = null, raw = false, span = false, formatValue }) {
  return (
    <div className={`form-field ${span ? styles.spanFull : ''}`}>
      <label className="form-label">{label}</label>
      {editing
        ? options
          ? <select className="form-input" value={value || ''} onChange={(event) => onChange(event.target.value)}>{options.map((option) => <option key={option}>{option}</option>)}</select>
          : <input className="form-input" type={type} value={value || ''} onChange={(event) => onChange(event.target.value)} />
        : <div className="form-input" style={{ background: 'var(--gray-50)', color: 'var(--gray-900)' }}>
          {raw && value !== null && value !== undefined && value !== ''
            ? <CopyValue value={value} label={label}>{String(value)}</CopyValue>
            : raw ? '—' : formatValue(value)}
        </div>
      }
    </div>
  )
}
