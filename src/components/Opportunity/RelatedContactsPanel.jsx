import { useState } from 'react'
import styles from '@/pages/OpportunityDetail.module.css'

export default function RelatedContactsPanel({ title, hint, matches, linkingContactId, getKey, onOpen, onLink }) {
  const [open, setOpen] = useState(false)
  if (!matches?.length) return null
  return (
    <div className={styles.relatedContacts}>
      <button type="button" className={styles.relatedContactsSummary} onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        <span><strong>{matches.length}</strong> {title.toLowerCase()}</span>
        <span>{open ? 'Hide suggestions' : 'Review suggestions'}</span>
      </button>
      {open && <div className={styles.relatedContactsList}>
        <div className={styles.relatedContactsHint}>{hint}</div>
        {matches.map(({ contact, reason }) => {
          const key = getKey(contact)
          const isLinking = linkingContactId === key
          return <div key={key} className={styles.relatedContactRow}>
            <button type="button" className={styles.relatedContactOpen} onClick={() => onOpen(contact)} title={`Open ${contact.Name || 'contact'}`}>
              <strong>{contact.Name}</strong>
              <span>{[contact.Title, contact.Email].filter(Boolean).join(' · ') || reason}</span>
            </button>
            <button type="button" className="btn text-sm" disabled={Boolean(linkingContactId)} onClick={() => onLink(contact)}>{isLinking ? 'Linking…' : 'Link'}</button>
          </div>
        })}
      </div>}
    </div>
  )
}
