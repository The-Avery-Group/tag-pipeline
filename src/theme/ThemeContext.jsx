import { createContext, useContext, useEffect, useMemo, useState } from 'react'

const THEME_STORAGE_KEY = 'tag_theme_preference'
const ThemeContext = createContext(null)

function getStoredPreference() {
  try {
    const value = localStorage.getItem(THEME_STORAGE_KEY)
    return ['light', 'dark', 'system'].includes(value) ? value : 'system'
  } catch {
    return 'system'
  }
}

function resolveTheme(preference) {
  if (preference !== 'system') return preference
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

export function ThemeProvider({ children }) {
  const [preference, setPreference] = useState(getStoredPreference)
  const [resolvedTheme, setResolvedTheme] = useState(() => resolveTheme(getStoredPreference()))

  useEffect(() => {
    const media = window.matchMedia?.('(prefers-color-scheme: dark)')
    const applyTheme = () => setResolvedTheme(resolveTheme(preference))
    applyTheme()
    if (preference !== 'system' || !media) return undefined
    media.addEventListener('change', applyTheme)
    return () => media.removeEventListener('change', applyTheme)
  }, [preference])

  useEffect(() => {
    document.documentElement.dataset.theme = resolvedTheme
    document.documentElement.style.colorScheme = resolvedTheme
  }, [resolvedTheme])

  const setThemePreference = (value) => {
    const next = ['light', 'dark', 'system'].includes(value) ? value : 'system'
    setPreference(next)
    try { localStorage.setItem(THEME_STORAGE_KEY, next) } catch {}
  }

  const value = useMemo(() => ({ preference, resolvedTheme, setThemePreference }), [preference, resolvedTheme])
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export function useTheme() {
  const context = useContext(ThemeContext)
  if (!context) throw new Error('useTheme must be used inside ThemeProvider')
  return context
}
