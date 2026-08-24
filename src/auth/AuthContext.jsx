import { createContext, useContext, useEffect, useRef, useState } from 'react'
import { useMsal } from '@azure/msal-react'
import { InteractionStatus } from '@azure/msal-browser'
import { appUrl, loginRequest, graphConfig, silentTokenOptions } from './msalConfig'
import { stopPolling } from '@/services/dataCache'
import { requestSessionRefresh } from '@/services/graphService'
import { getTransactionCodingAccess } from '@/services/transactionCodingService'

const AuthContext = createContext(null)

export function AuthProvider({ children }) {
  const { instance, accounts, inProgress } = useMsal()
  const [user, setUser]     = useState(null)
  const [authState, setAuthState] = useState('initializing')
  const [transactionCodingAccess, setTransactionCodingAccess] = useState({ allowed: false, loaded: false })
  const signingOutRef = useRef(false)

  useEffect(() => {
    if (signingOutRef.current) {
      setUser(null)
      setTransactionCodingAccess({ allowed: false, loaded: false })
      setAuthState('idle')
      return
    }

    if (accounts.length === 0) {
      setTransactionCodingAccess({ allowed: false, loaded: false })
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
      .then(() => instance.acquireTokenSilent({ ...loginRequest, ...silentTokenOptions, account }))
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
        if (/refresh_token_expired|interaction_required|login_required/i.test(`${err?.errorCode || ''} ${err?.message || ''}`)) {
          requestSessionRefresh(err)
        }
        setUser({
          displayName: account.name,
          firstName:   account.name.split(' ')[0],
          email:       account.username,
          id:          account.localAccountId,
        })
      })
      .finally(() => setAuthState('idle'))
  }, [accounts, instance])

  useEffect(() => {
    let active = true
    if (!user) return undefined
    setTransactionCodingAccess({ allowed: false, loaded: false })
    getTransactionCodingAccess()
      .then((access) => {
        if (active) setTransactionCodingAccess({ allowed: access.allowed === true, loaded: true })
      })
      .catch((error) => {
        console.warn('Could not determine Transaction Coding access:', error.message)
        if (active) setTransactionCodingAccess({ allowed: false, loaded: true })
      })
    return () => { active = false }
  }, [user?.id])

  const login = () => {
    signingOutRef.current = false
    return instance.loginRedirect(loginRequest)
  }

  const logout = () => {
    // Clear the app session before leaving for Entra. A popup confines the
    // Entra sign-out page to a short-lived window, so the main tab returns to
    // this app's sign-in screen immediately instead of occasionally remaining
    // on Microsoft's sign-out page.
    signingOutRef.current = true
    setUser(null)
    setTransactionCodingAccess({ allowed: false, loaded: false })
    setAuthState('idle')
    stopPolling()

    const account = instance.getActiveAccount() || accounts[0]
    return instance.logoutPopup({
      account,
      postLogoutRedirectUri: appUrl,
      mainWindowRedirectUri: appUrl,
      popupWindowAttributes: { popupSize: { width: 520, height: 620 } },
    }).catch((err) => {
      // A browser can block a popup in edge cases. The local app session has
      // already ended, so keep the user on the sign-in screen rather than
      // sending the main tab to an Entra page that may not redirect back.
      console.error('Sign-out popup failed:', err)
      instance.clearCache({ account }).catch((cacheErr) => {
        console.error('Could not clear the local sign-out cache:', cacheErr)
      })
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
      canAccessTransactionCoding: transactionCodingAccess.allowed,
      transactionCodingAccessLoading: Boolean(user) && !transactionCodingAccess.loaded,
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
