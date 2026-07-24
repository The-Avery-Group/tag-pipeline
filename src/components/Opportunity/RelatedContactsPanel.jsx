import styles from '@/pages/OpportunityDetail.module.css'

export default function RelatedContactsPanel({ title, hint, matches, linkingContactId, getKey, onOpen, onLink }) {
  if (!matches?.length) return null
  return (
    <div className={styles.relatedContacts}>
      <div className={styles.relatedContactsTitle}>{title}</div>
      <div className={styles.relatedContactsHint}>{hint}</div>
      {matches.map(({ contact, reason }) => {
        const key = getKey(contact)
        const isLinking = linkingContactId === key
        return <div key={key} className={styles.contactCard}>
          <button type="button" className={styles.contactOpen} onClick={() => onOpen(contact)} title={`Open ${contact.Name || 'contact'}`}>
            <span className={styles.contactAv}>{contact.Name?.split(' ').map((name) => name[0]).slice(0, 2).join('')}</span>
            <span className={styles.contactInfo}>
              <span className={styles.contactName}>{contact.Name}</span>
              <span className={styles.contactSub}>{[contact.Title, contact.Email].filter(Boolean).join(' · ') || 'Related contact'}</span>
              <span className={styles.relatedContactReason}>{reason}</span>
            </span>
          </button>
          <button type="button" className="btn btn-primary text-sm" disabled={Boolean(linkingContactId)} onClick={() => onLink(contact)}>{isLinking ? 'Linking…' : 'Link'}</button>
        </div>
      })}
    </div>
  )
}
