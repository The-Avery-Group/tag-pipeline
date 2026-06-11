import { createContext, useContext, useEffect, useState } from 'react'
import { useMsal } from '@azure/msal-react'
import { loginRequest, graphConfig } from './msalConfig'
import { warmCache, startPolling, stopPolling } from '@/services/dataCache'

const AuthContext = createContext(null)

export function AuthProvider({ children }) {
  const { instance, accounts } = useMsal()
  const [user, setUser]     = useState(null)
  const [authState, setAuthState] = useState('initializing')

  useEffect(() => {
    if (accounts.length === 0) {
      setAuthState('idle')
      return
    }

    const account = accounts[0]
    instance
      .initialize()
      .then(() => instance.acquireTokenSilent({ ...loginRequest, account }))
      .then((response) =>
        fetch(graphConfig.graphMeEndpoint, {
          headers: { Authorization: `Bearer ${response.accessToken}` },
        })
      )
      .then((res) => res.json())
      .then((me) => {
        setUser({
          displayName: me.displayName,
          firstName:   me.givenName || me.displayName.split(' ')[0],
          email:       me.mail || me.userPrincipalName,
          id:          me.id,
        })
        warmCache().then(() => startPolling())
      })
      .catch((err) => {
        console.error('Failed to load user profile:', err)
        setUser({
          displayName: account.name,
          firstName:   account.name.split(' ')[0],
          email:       account.username,
          id:          account.localAccountId,
        })
        warmCache().then(() => startPolling())
      })
      .finally(() => setAuthState('idle'))
  }, [accounts, instance])

  const login = () => instance.loginRedirect(loginRequest)

  const logout = () => {
    stopPolling()
    instance.logoutRedirect({
      postLogoutRedirectUri: import.meta.env.VITE_APP_BASE_URL || window.location.origin,
    })
  }

  return (
    <AuthContext.Provider value={{
      user,
      loading: authState === 'initializing',
      login,
      logout,
      isAuthenticated: !!user,
    }}>
      {children}
    </AuthContext.Provider>
  )
}

export const useAuth = () => {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider')
  return ctx
}
