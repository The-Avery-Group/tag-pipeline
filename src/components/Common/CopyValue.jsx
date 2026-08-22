import { useState } from 'react'
import styles from './CopyValue.module.css'

export default function CopyValue({ value, children, label = 'value', className = '' }) {
  const [copied, setCopied] = useState(false)
  const text = String(value ?? '').trim()
  if (!text) return children || '—'
  const copy = async (event) => {
    event.preventDefault()
    event.stopPropagation()
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
    } else {
      const input = document.createElement('textarea')
      input.value = text
      input.setAttribute('readonly', '')
      input.style.position = 'fixed'
      input.style.opacity = '0'
      document.body.appendChild(input)
      input.select()
      document.execCommand('copy')
      input.remove()
    }
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1400)
  }
  return <span className={`${styles.wrap} ${className}`}>
    <span className={styles.value}>{children || text}</span>
    <button type="button" className={styles.button} onClick={copy} title={copied ? 'Copied' : `Copy ${label}`} aria-label={copied ? `${label} copied` : `Copy ${label}`}>{copied ? '✓' : '⧉'}</button>
  </span>
}
