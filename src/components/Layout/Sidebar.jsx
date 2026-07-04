import { NavLink } from 'react-router-dom'
import { useAuth } from '@/auth/AuthContext'
import styles from './Sidebar.module.css'

const NAV = [
  { to: '/',               icon: '⊞', label: 'Dashboard',      end: true },
  { to: '/opportunities',  icon: '◈', label: 'Opportunities' },
  { to: '/pipeline-board', icon: '⬦', label: 'Pipeline Board' },
  { to: '/lookup',         icon: '⌕', label: 'Lookup' },
  { to: '/tasks',          icon: '☑', label: 'Tasks' },
  { to: '/contacts',       icon: '◎', label: 'Contacts' },
  { to: '/ai-chat',        icon: '✦', label: 'AI Advisor' },
]

export default function Sidebar({ onSearchOpen }) {
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

      {/* Notion-style search trigger */}
      <button className={styles.searchTrigger} onClick={onSearchOpen} aria-label="Search">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
        </svg>
        <span>Search</span>
        <kbd className={styles.kbd}>⌘K</kbd>
      </button>

      <nav className={styles.nav}>
        {NAV.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            className={({ isActive }) =>
              `${styles.navItem} ${isActive ? styles.active : ''}`
            }
          >
            <span className={styles.navIcon} aria-hidden="true">{item.icon}</span>
            {item.label}
          </NavLink>
        ))}
      </nav>

      <div className={styles.footer}>
        <div className={styles.userInfo}>
          <div className={styles.avatar}>{initials}</div>
          <div>
            <div className={styles.userName}>{user?.displayName}</div>
            <div className={styles.userRole}>Editor</div>
          </div>
        </div>
        <div className={styles.footerActions}>
          <NavLink
            to="/settings"
            className={({ isActive }) =>
              `${styles.settingsBtn} ${isActive ? styles.settingsBtnActive : ''}`
            }
          >
            <span aria-hidden="true">⚙</span> Settings
          </NavLink>
          <button className={styles.signOutBtn} onClick={logout}>
            <span aria-hidden="true">⬡</span> Sign out
          </button>
        </div>
      </div>
    </aside>
  )
}
