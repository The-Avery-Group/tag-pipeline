import { NavLink } from 'react-router-dom'
import { useAuth } from '@/auth/AuthContext'
import { useTheme } from '@/theme/ThemeContext'
import styles from './Sidebar.module.css'

const NAV = [
  { to: '/',               icon: 'dashboard',     label: 'Dashboard',      end: true },
  { to: '/opportunities',  icon: 'opportunities', label: 'Opportunities' },
  { to: '/pipeline-board', icon: 'pipeline',      label: 'Pipeline Board' },
  { to: '/lookup',         icon: 'search',        label: 'Lookup' },
  { to: '/tasks',          icon: 'tasks',         label: 'Tasks' },
  { to: '/contacts',       icon: 'contacts',      label: 'Contacts' },
  { to: '/partners',       icon: 'partners',      label: 'Partners' },
  { to: '/ai-chat',        icon: 'advisor',       label: 'AI Advisor' },
]

function NavIcon({ name }) {
  const props = { className: styles.navIcon, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.9, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true }
  const paths = {
    dashboard: <><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="11" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="18" width="7" height="3" rx="1"/></>,
    opportunities: <><rect x="3" y="7" width="18" height="12" rx="2"/><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M3 12h18"/></>,
    pipeline: <><rect x="3" y="4" width="5" height="16" rx="1"/><rect x="10" y="4" width="5" height="10" rx="1"/><rect x="17" y="4" width="4" height="16" rx="1"/></>,
    search: <><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></>,
    tasks: <><path d="M9 6h11M9 12h11M9 18h11M3 6h.01M3 12h.01M3 18h.01"/></>,
    contacts: <><circle cx="9" cy="8" r="3"/><path d="M3 20c.5-3.5 2.5-5 6-5s5.5 1.5 6 5M17 7h4M19 5v4"/></>,
    partners: <><path d="M8 12 5.5 9.5a2.2 2.2 0 0 0-3 3L7 17l4-4M16 12l2.5-2.5a2.2 2.2 0 0 1 3 3L17 17l-4-4"/><path d="m9 14 2-2 2 2"/></>,
    advisor: <><path d="m12 3 1.6 4.4L18 9l-4.4 1.6L12 15l-1.6-4.4L6 9l4.4-1.6ZM19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8Z"/></>,
    transactions: <><path d="M5 3h14v18l-2.5-1.5L14 21l-2-1.5L10 21l-2.5-1.5L5 21Z"/><path d="M8 7h8M8 11h8M8 15h5"/></>,
    settings: <><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1-2.1 2.1-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5v.1h-3v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1-2.1-2.1.1-.1A1.6 1.6 0 0 0 7.2 15a1.6 1.6 0 0 0-1.5-1H5.6v-3h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1L8.9 6l.1.1a1.6 1.6 0 0 0 1.8.3 1.6 1.6 0 0 0 1-1.5v-.1h3v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1 2.1 2.1-.1.1a1.6 1.6 0 0 0-.3 1.8 1.6 1.6 0 0 0 1.5 1h.1v3h-.1a1.6 1.6 0 0 0-1.5 1Z"/></>,
    sun: <><circle cx="12" cy="12" r="3.5"/><path d="M12 2v2M12 20v2M4.93 4.93l1.42 1.42M17.65 17.65l1.42 1.42M2 12h2M20 12h2M4.93 19.07l1.42-1.42M17.65 6.35l1.42-1.42"/></>,
    moon: <path d="M20.5 15.2A8.4 8.4 0 0 1 8.8 3.5 8.5 8.5 0 1 0 20.5 15.2Z"/>,
    signOut: <><path d="m10 17 5-5-5-5M15 12H3M21 3v18H10"/></>,
    panelClose: <><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16m7-11-3 3 3 3"/></>,
    panelOpen: <><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16M13 9l3 3-3 3"/></>,
  }
  return <svg {...props}>{paths[name]}</svg>
}

export default function Sidebar({ collapsed = false, onCollapsedChange, onSearchOpen }) {
  const { user, logout } = useAuth()
  const { resolvedTheme, setThemePreference } = useTheme()
  const quickTheme = resolvedTheme === 'dark' ? 'light' : 'dark'
  const assetBase = import.meta.env.BASE_URL
  const initials = user?.displayName
    ?.split(' ')
    .map((n) => n[0])
    .slice(0, 2)
    .join('') || '?'

  return (
    <aside className={`${styles.sidebar} ${collapsed ? styles.collapsed : ''}`}>
      <div className={styles.logo}>
        <div className={styles.expandedBrand}>
          <div className={styles.logoImageWrap}>
            <img className={`${styles.logoImage} ${styles.logoImageLight}`} src={`${assetBase}avery-group-logo.png`} alt="The Avery Group" />
            <img className={`${styles.logoImage} ${styles.logoImageDark}`} src={`${assetBase}avery-group-logo-dark.png`} alt="" aria-hidden="true" />
          </div>
          <span className={styles.logoProduct}>• CRM</span>
        </div>
        <span className={styles.compactBrand} aria-hidden={!collapsed}>CRM</span>
      </div>

      <button
        type="button"
        className={styles.collapseToggle}
        onClick={() => onCollapsedChange?.(!collapsed)}
        aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        aria-expanded={!collapsed}
        title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
      >
        <NavIcon name={collapsed ? 'panelOpen' : 'panelClose'} />
      </button>

      {/* Notion-style search trigger */}
      <button className={styles.searchTrigger} onClick={onSearchOpen} aria-label="Search CRM" title={collapsed ? 'Search CRM' : undefined}>
        <NavIcon name="search" />
        <span className={styles.searchLabel}>Search CRM</span>
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
            title={collapsed ? item.label : undefined}
            aria-label={collapsed ? item.label : undefined}
          >
            <NavIcon name={item.icon} />
            <span className={styles.navLabel}>{item.label}</span>
          </NavLink>
        ))}
        <div className={styles.financeSection}>
          <span className={styles.financeLabel}>Finance</span>
          <NavLink
            to="/transaction-coding"
            className={({ isActive }) => `${styles.navItem} ${isActive ? styles.active : ''}`}
            title={collapsed ? 'Transaction Coding' : undefined}
            aria-label={collapsed ? 'Transaction Coding' : undefined}
          >
            <NavIcon name="transactions" />
            <span className={styles.navLabel}>Transaction Coding</span>
          </NavLink>
        </div>
      </nav>

      <div className={styles.footer}>
        <div className={styles.userInfo} title={collapsed ? user?.displayName : undefined}>
          <div className={styles.avatar}>{initials}</div>
          <div className={styles.userText}>
            <div className={styles.userName}>{user?.displayName}</div>
          </div>
        </div>
        <div className={styles.footerActions}>
          <div className={styles.footerUtilityRow}>
            <NavLink
              to="/settings"
              className={({ isActive }) =>
                `${styles.settingsBtn} ${isActive ? styles.settingsBtnActive : ''}`
              }
              title={collapsed ? 'Settings' : undefined}
              aria-label={collapsed ? 'Settings' : undefined}
            >
              <NavIcon name="settings" /> <span className={styles.actionLabel}>Settings</span>
            </NavLink>
            <button
              type="button"
              className={styles.themeToggle}
              onClick={() => setThemePreference(quickTheme)}
              aria-label={`Switch to ${quickTheme} mode`}
              title={`Switch to ${quickTheme} mode`}
            >
              <NavIcon name={resolvedTheme === 'dark' ? 'sun' : 'moon'} />
            </button>
          </div>
          <button className={styles.signOutBtn} onClick={logout} title={collapsed ? 'Sign out' : undefined} aria-label={collapsed ? 'Sign out' : undefined}>
            <NavIcon name="signOut" /> <span className={styles.actionLabel}>Sign out</span>
          </button>
        </div>
      </div>
    </aside>
  )
}
