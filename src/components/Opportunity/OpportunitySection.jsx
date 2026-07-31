import styles from '@/pages/OpportunityDetail.module.css'

export default function OpportunitySection({ title, children, id, className = '' }) {
  return (
    <section id={id} className={`${styles.section} ${className}`.trim()}>
      <div className={styles.sectionHeader}>{title}</div>
      <div className={`card ${styles.sectionCard}`}>{children}</div>
    </section>
  )
}
