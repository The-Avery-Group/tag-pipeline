import { Component, Suspense, lazy, useState, useEffect } from 'react'
import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom'
import { MsalProvider } from '@azure/msal-react'
import { msalInstance } from '@/auth/msalConfig'
import { AuthProvider, useAuth } from '@/auth/AuthContext'
import { useToast } from '@/hooks/useToast'
import { useAgingNotifications } from '@/hooks/useAgingNotifications'
import { ThemeProvider } from '@/theme/ThemeContext'
import { ToastContainer } from '@/components/Common/Toast'
import Sidebar from '@/components/Layout/Sidebar'
import AIChat from '@/pages/AIChat'
import { warmCache, startPolling, isCacheWarmed } from '@/services/dataCache'
import '@/styles/global.css'
const SearchModal = lazy(() => import('@/pages/SearchModal'))

const Dashboard         = lazy(() => import('@/pages/Dashboard'))
const Opportunities     = lazy(() => import('@/pages/Opportunities'))
const OpportunityDetail = lazy(() => import('@/pages/OpportunityDetail'))
const PipelineBoard     = lazy(() => import('@/pages/PipelineBoard'))
const Tasks             = lazy(() => import('@/pages/Tasks'))
const Contacts          = lazy(() => import('@/pages/Contacts'))
const Partners          = lazy(() => import('@/pages/Partners'))
const Settings          = lazy(() => import('@/pages/Settings'))
const Lookup            = lazy(() => import('@/pages/Lookup'))
const Login             = lazy(() => import('@/pages/Login'))

// Shown only while lazy chunks load (very brief)
function PageFallback() {
  return (
    <div style={{ padding: 24 }}>
      {[1, 2, 3].map((i) => (
        <div key={i} className="skeleton" style={{ height: 40, marginBottom: 10, borderRadius: 8 }} />
      ))}
    </div>
  )
}

// A failed lazy chunk or a render exception previously left the main content
// area empty, which made an affected route (including AI Advisor) look like a
// blank screen. Keep the sidebar available and give the user a safe recovery
// action instead.
class RouteErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error, info) {
    console.error('Page failed to render:', error, info)
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 32, maxWidth: 560 }}>
          <h1 style={{ margin: '0 0 8px', fontSize: 20 }}>This page could not load</h1>
          <p style={{ margin: '0 0 18px', color: 'var(--gray-500)', lineHeight: 1.55 }}>
            Reload the app to retrieve the latest version. If this keeps happening, please report it to your administrator.
          </p>
          <button className="btn btn-primary" onClick={() => window.location.reload()}>
            Reload app
          </button>
        </div>
      )
    }
    return this.props.children
  }
}

// Shown only during the very first MSAL initialisation (first-ever page load
// before any session exists). On subsequent refreshes the silent token
// acquisition completes fast enough that this is skipped or shows briefly.
function AuthInitScreen() {
  return (
    <div style={{
      height: '100vh', display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center', gap: 16,
      background: 'var(--gray-100)',
    }}>
      <div style={{ display: 'flex', gap: 8 }}>
        {[0, 1, 2].map((i) => (
          <div key={i} style={{
            width: 10, height: 10, borderRadius: '50%',
            background: 'var(--blue-600)',
            animation: `authDot 1.2s ease-in-out ${i * 0.2}s infinite`,
          }} />
        ))}
      </div>
      <div style={{ textAlign: 'center' }}>
        <div style={{ color: 'var(--gray-900)', fontSize: 14, fontWeight: 600 }}>Signing you in</div>
        <div style={{ color: 'var(--gray-500)', fontSize: 12, marginTop: 4 }}>Preparing your workspace…</div>
      </div>
      <style>{`
        @keyframes authDot {
          0%, 80%, 100% { transform: scale(0.6); opacity: 0.4; }
          40%            { transform: scale(1);   opacity: 1;   }
        }
      `}</style>
    </div>
  )
}

function AppShell() {
  const { isAuthenticated, loading } = useAuth()
  const location = useLocation()
  const { toasts, toast } = useToast()
  const [cacheReady,    setCacheReady]    = useState(isCacheWarmed)
  const [searchOpen,    setSearchOpen]    = useState(false)
  useAgingNotifications()

  // Global Cmd/Ctrl+K to open search
  useEffect(() => {
    const handler = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault()
        setSearchOpen(true)
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [])

  // After authentication, warm the cache before showing the app shell.
  // This fills the gap between "user picked account" and "data is ready"
  // with the same 3-dot animation instead of a blank/skeleton screen.
  useEffect(() => {
    if (!isAuthenticated || cacheReady) return
    warmCache().then(() => {
      startPolling()
      setCacheReady(true)
    })
  }, [isAuthenticated, cacheReady])

  // Sign-out clears the in-memory cache. Reset this component's readiness
  // state as well, so a later sign-in always warms the new session first.
  useEffect(() => {
    if (!isAuthenticated) setCacheReady(false)
  }, [isAuthenticated])

  if (loading || (isAuthenticated && !cacheReady)) return <AuthInitScreen />

  if (!isAuthenticated) {
    return (
      <Suspense fallback={<AuthInitScreen />}>
        <Login />
      </Suspense>
    )
  }

  return (
    <div className="app-layout">
      <Sidebar onSearchOpen={() => setSearchOpen(true)} />
      <div className="main-content">
        <RouteErrorBoundary key={location.pathname}>
          <Suspense fallback={<PageFallback />}>
            <Routes>
              <Route path="/"                              element={<Dashboard toast={toast} />} />
              <Route path="/opportunities"                 element={<Opportunities toast={toast} />} />
              <Route path="/opportunities/:contractNumber" element={<OpportunityDetail toast={toast} />} />
              <Route path="/pipeline-board"                element={<PipelineBoard toast={toast} />} />
              <Route path="/ai-chat"                       element={<AIChat toast={toast} />} />
              <Route path="/tasks"                         element={<Tasks toast={toast} />} />
              <Route path="/contacts"                      element={<Contacts toast={toast} />} />
              <Route path="/partners"                      element={<Partners toast={toast} />} />
              <Route path="/settings"                      element={<Settings toast={toast} />} />
              <Route path="/lookup"                         element={<Lookup toast={toast} />} />
              <Route path="*"                              element={<Navigate to="/" replace />} />
            </Routes>
          </Suspense>
        </RouteErrorBoundary>
      </div>
      {searchOpen && (
          <Suspense fallback={null}>
            <SearchModal onClose={() => setSearchOpen(false)} />
          </Suspense>
        )}
      <ToastContainer toasts={toasts} />
    </div>
  )
}

export default function App() {
  return (
    <MsalProvider instance={msalInstance}>
      <AuthProvider>
        <BrowserRouter basename="/tag-pipeline">
          <ThemeProvider>
            <AppShell />
          </ThemeProvider>
        </BrowserRouter>
      </AuthProvider>
    </MsalProvider>
  )
}
