import { NavLink } from 'react-router-dom'
import { useAuth } from '@/auth/AuthContext'
import styles from './Sidebar.module.css'

const NAV = [
  { to: '/',              icon: '⊞', label: 'Dashboard' },
  { to: '/opportunities', icon: '◈', label: 'Opportunities' },
  { to: '/tasks',         icon: '☑', label: 'Tasks' },
]

const DIR = [
  { to: '/contacts',  icon: '◎', label: 'Contacts' },
  { to: '/settings',  icon: '⚙', label: 'Settings' },
]

export default function Sidebar() {
  const { user, logout } = useAuth()
  const initials = user?.displayName
    ?.split(' ')
    .map((n) => n[0])
    .slice(0, 2)
    .join('') || '?'

  return (
    <aside className={styles.sidebar}>
      <div className={styles.logo}>
        <div className={styles.logoName}>TAG Capture</div>
        <div className={styles.logoSub}>Pipeline Manager</div>
      </div>

      <nav className={styles.nav}>
        <div className={styles.navSection}>Pipeline</div>
        {NAV.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.to === '/'}
            className={({ isActive }) =>
              `${styles.navItem} ${isActive ? styles.active : ''}`
            }
          >
            <span className={styles.navIcon} aria-hidden="true">{item.icon}</span>
            {item.label}
          </NavLink>
        ))}

        <div className={styles.navSection}>Directory</div>
        {DIR.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            className={({ isActive }) =>
              `${styles.navItem} ${isActive ? styles.active : ''}`
            }
          >
            <span className={styles.navIcon} aria-hidden="true">{item.icon}</span>
            {item.label}
          </NavLink>
        ))}
      </nav>

      {/* Footer: user info + sign out at bottom */}
      <div className={styles.footer}>
        <div className={styles.userInfo}>
          <div className={styles.avatar}>{initials}</div>
          <div>
            <div className={styles.userName}>{user?.displayName}</div>
            <div className={styles.userRole}>Editor</div>
          </div>
        </div>
        <button className={styles.signOutBtn} onClick={logout}>
          <span aria-hidden="true">⬡</span> Sign out
        </button>
      </div>
    </aside>
  )
}