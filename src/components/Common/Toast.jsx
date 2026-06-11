import styles from './Toast.module.css'

export function ToastContainer({ toasts }) {
  return (
    <div className={styles.container} role="region" aria-live="polite" aria-label="Notifications">
      {toasts.map((t) => (
        <div key={t.id} className={`${styles.toast} ${styles[t.type]}`}>
          {t.message}
        </div>
      ))}
    </div>
  )
}
