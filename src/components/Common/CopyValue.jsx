import { useState } from 'react'
import styles from './CopyValue.module.css'

export default function CopyValue({ value, children, label = 'value', className = '' }) {
  const [copied, setCopied] = useState(false)
  const text = String(value ?? '').trim()
  if (!text) return children || '—'
  const copy = async (event) => {
    event.preventDefault()
    event.stopPropagation()
    await navigator.clipboard.writeText(text)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1400)
  }
  return <span className={`${styles.wrap} ${className}`}>
    <span className={styles.value}>{children || text}</span>
    <button type="button" className={styles.button} onClick={copy} title={copied ? 'Copied' : `Copy ${label}`} aria-label={copied ? `${label} copied` : `Copy ${label}`}>{copied ? '✓' : '⧉'}</button>
  </span>
}
