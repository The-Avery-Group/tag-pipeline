import styles from '@/pages/OpportunityDetail.module.css'

export default function OpportunitySection({ title, children }) {
  return (
    <div className={styles.section}>
      <div className={styles.sectionHeader}>{title}</div>
      <div className={`card ${styles.sectionCard}`}>{children}</div>
    </div>
  )
}
