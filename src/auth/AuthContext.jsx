import { createContext, useContext, useEffect, useRef, useState } from 'react'
import { useMsal } from '@azure/msal-react'
import { InteractionStatus } from '@azure/msal-browser'
import { loginRequest, graphConfig } from './msalConfig'
import { stopPolling } from '@/services/dataCache'

const AuthContext = createContext(null)

export function AuthProvider({ children }) {
  const { instance, accounts, inProgress } = useMsal()
  const [user, setUser]     = useState(null)
  const [authState, setAuthState] = useState('initializing')
  const signingOutRef = useRef(false)

  useEffect(() => {
    if (signingOutRef.current) {
      setUser(null)
      setAuthState('idle')
      return
    }

    if (accounts.length === 0) {
      setAuthState('idle')
      return
    }

    // MSAL first restores the redirect result, then exposes the selected
    // account. Return to a loading state for the profile/token step so the
    // login screen is never briefly shown after account selection.
    setAuthState('initializing')
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
        if (signingOutRef.current) return
        setUser({
          displayName: me.displayName,
          firstName:   me.givenName || me.displayName.split(' ')[0],
          email:       me.mail || me.userPrincipalName,
          id:          me.id,
        })
      })
      .catch((err) => {
        if (signingOutRef.current) return
        console.error('Failed to load user profile:', err)
        setUser({
          displayName: account.name,
          firstName:   account.name.split(' ')[0],
          email:       account.username,
          id:          account.localAccountId,
        })
      })
      .finally(() => setAuthState('idle'))
  }, [accounts, instance])

  const login = () => {
    signingOutRef.current = false
    return instance.loginRedirect(loginRequest)
  }

  const logout = () => {
    // Clear the app session before leaving for Entra. This guarantees the
    // login screen appears even if the identity-provider redirect is delayed
    // or fails, and prevents an in-flight profile request restoring the user.
    signingOutRef.current = true
    setUser(null)
    setAuthState('idle')
    stopPolling()
    return instance.logoutRedirect({
      postLogoutRedirectUri: import.meta.env.VITE_APP_BASE_URL || window.location.origin,
    }).catch((err) => {
      // The local session is already cleared. Keep the user safely on the
      // sign-in page and expose the redirect failure for diagnosis.
      console.error('Sign-out redirect failed:', err)
    })
  }

  return (
    <AuthContext.Provider value={{
      user,
      // During a redirect return, MSAL handles the response before it places
      // the account in `accounts`. Keeping this state in the loading signal
      // removes the otherwise visible Login-page flash in that interval.
      loading: authState === 'initializing' || inProgress !== InteractionStatus.None,
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
