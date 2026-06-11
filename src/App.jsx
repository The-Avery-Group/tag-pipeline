import { Suspense, lazy } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { MsalProvider } from '@azure/msal-react'
import { msalInstance } from '@/auth/msalConfig'
import { AuthProvider, useAuth } from '@/auth/AuthContext'
import { useToast } from '@/hooks/useToast'
import { ToastContainer } from '@/components/Common/Toast'
import Sidebar from '@/components/Layout/Sidebar'
import '@/styles/global.css'

// Lazy-load all pages for code splitting
const Dashboard          = lazy(() => import('@/pages/Dashboard'))
const Opportunities      = lazy(() => import('@/pages/Opportunities'))
const OpportunityDetail  = lazy(() => import('@/pages/OpportunityDetail'))
const Tasks              = lazy(() => import('@/pages/Tasks'))
const Contacts           = lazy(() => import('@/pages/Contacts'))
const Login              = lazy(() => import('@/pages/Login'))

function PageFallback() {
  return (
    <div style={{ padding: 24 }}>
      {[1, 2, 3].map((i) => (
        <div key={i} className="skeleton" style={{ height: 40, marginBottom: 10, borderRadius: 8 }} />
      ))}
    </div>
  )
}

function AppShell() {
  const { isAuthenticated, loading } = useAuth()
  const { toasts, toast } = useToast()

  if (loading) return <PageFallback />

  if (!isAuthenticated) {
    return (
      <Suspense fallback={<PageFallback />}>
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
            <Route path="/"                           element={<Dashboard toast={toast} />} />
            <Route path="/opportunities"              element={<Opportunities toast={toast} />} />
            <Route path="/opportunities/:contractNumber" element={<OpportunityDetail toast={toast} />} />
            <Route path="/tasks"                      element={<Tasks toast={toast} />} />
            <Route path="/contacts"                   element={<Contacts toast={toast} />} />
            <Route path="*"                           element={<Navigate to="/" replace />} />
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
