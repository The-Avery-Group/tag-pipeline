import { Suspense, lazy, useState, useEffect } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { MsalProvider } from '@azure/msal-react'
import { msalInstance } from '@/auth/msalConfig'
import { AuthProvider, useAuth } from '@/auth/AuthContext'
import { useToast } from '@/hooks/useToast'
import { useAgingNotifications } from '@/hooks/useAgingNotifications'
import { ToastContainer } from '@/components/Common/Toast'
import Sidebar from '@/components/Layout/Sidebar'
import { warmCache, startPolling, isCacheWarmed } from '@/services/dataCache'
import '@/styles/global.css'
const SearchModal = lazy(() => import('@/pages/SearchModal'))

const Dashboard         = lazy(() => import('@/pages/Dashboard'))
const Opportunities     = lazy(() => import('@/pages/Opportunities'))
const OpportunityDetail = lazy(() => import('@/pages/OpportunityDetail'))
const PipelineBoard     = lazy(() => import('@/pages/PipelineBoard'))
const AIChat            = lazy(() => import('@/pages/AIChat'))
const Tasks             = lazy(() => import('@/pages/Tasks'))
const Contacts          = lazy(() => import('@/pages/Contacts'))
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
        <Suspense fallback={<PageFallback />}>
          <Routes>
            <Route path="/"                              element={<Dashboard toast={toast} />} />
            <Route path="/opportunities"                 element={<Opportunities toast={toast} />} />
            <Route path="/opportunities/:contractNumber" element={<OpportunityDetail toast={toast} />} />
            <Route path="/pipeline-board"                element={<PipelineBoard toast={toast} />} />
            <Route path="/ai-chat"                       element={<AIChat toast={toast} />} />
            <Route path="/tasks"                         element={<Tasks toast={toast} />} />
            <Route path="/contacts"                      element={<Contacts toast={toast} />} />
            <Route path="/settings"                      element={<Settings toast={toast} />} />
            <Route path="/lookup"                         element={<Lookup toast={toast} />} />
            <Route path="*"                              element={<Navigate to="/" replace />} />
          </Routes>
        </Suspense>
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
          <AppShell />
        </BrowserRouter>
      </AuthProvider>
    </MsalProvider>
  )
}
