import { useAuth } from '@/auth/AuthContext'
import styles from './Login.module.css'

export default function Login() {
  const { login } = useAuth()

  return (
    <div className={styles.page}>
      <div className={styles.card}>
        <div className={styles.logo}>
          <div className={styles.logoMark}>TC</div>
          <div>
            <div className={styles.appName}>TAG CRM</div>
            <div className={styles.appSub}>GovCon capture and pipeline management</div>
          </div>
        </div>

        <h1 className={styles.heading}>Sign in to your workspace</h1>
        <p className={styles.description}>
          Use your Microsoft work account to access the pipeline. No new passwords required.
        </p>

        <button className={styles.msBtn} onClick={login}>
          <svg width="18" height="18" viewBox="0 0 21 21" aria-hidden="true">
            <rect x="1" y="1" width="9" height="9" fill="#F25022"/>
            <rect x="11" y="1" width="9" height="9" fill="#7FBA00"/>
            <rect x="1" y="11" width="9" height="9" fill="#00A4EF"/>
            <rect x="11" y="11" width="9" height="9" fill="#FFB900"/>
          </svg>
          Sign in with Microsoft
        </button>

        <p className={styles.footer}>
          Secured by Microsoft Entra ID · Your credentials never leave Microsoft's servers.
        </p>
      </div>
    </div>
  )
}
