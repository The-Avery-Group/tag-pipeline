import { Suspense, lazy } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { MsalProvider } from '@azure/msal-react'
import { msalInstance } from '@/auth/msalConfig'
import { AuthProvider, useAuth } from '@/auth/AuthContext'
import { useToast } from '@/hooks/useToast'
import { ToastContainer } from '@/components/Common/Toast'
import Sidebar from '@/components/Layout/Sidebar'
import '@/styles/global.css'

const Dashboard         = lazy(() => import('@/pages/Dashboard'))
const Opportunities     = lazy(() => import('@/pages/Opportunities'))
const OpportunityDetail = lazy(() => import('@/pages/OpportunityDetail'))
const Tasks             = lazy(() => import('@/pages/Tasks'))
const Contacts          = lazy(() => import('@/pages/Contacts'))
const Settings          = lazy(() => import('@/pages/Settings'))
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

  // Only block the UI during true MSAL initialisation
  if (loading) return <AuthInitScreen />

  if (!isAuthenticated) {
    return (
      <Suspense fallback={<AuthInitScreen />}>
        <Login />
      </Suspense>
    )
  }

  return (
    <div className="app-layout">
      <Sidebar />
      <div className="main-content">
        <Suspense fallback={<PageFallback />}>
          <Routes>
            <Route path="/"                              element={<Dashboard toast={toast} />} />
            <Route path="/opportunities"                 element={<Opportunities toast={toast} />} />
            <Route path="/opportunities/:contractNumber" element={<OpportunityDetail toast={toast} />} />
            <Route path="/tasks"                         element={<Tasks toast={toast} />} />
            <Route path="/contacts"                      element={<Contacts toast={toast} />} />
            <Route path="/settings"                      element={<Settings toast={toast} />} />
            <Route path="*"                              element={<Navigate to="/" replace />} />
          </Routes>
        </Suspense>
      </div>
      <ToastContainer toasts={toasts} />
    </div>
  )
}

export default function App() {
  return (
    <MsalProvider instance={msalInstance}>
      <AuthProvider>
        <BrowserRouter>
          <AppShell />
        </BrowserRouter>
      </AuthProvider>
    </MsalProvider>
  )
}