import { createContext, useContext, useEffect, useState } from 'react'
import { useMsal } from '@azure/msal-react'
import { loginRequest, graphConfig } from './msalConfig'

const AuthContext = createContext(null)

export function AuthProvider({ children }) {
  const { instance, accounts } = useMsal()
  const [user, setUser] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (accounts.length === 0) {
      setLoading(false)
      return
    }
    const account = accounts[0]
    instance
      .initialize()
      .then(() => instance.acquireTokenSilent({ ...loginRequest, account }))
      .then((response) => {
        return fetch(graphConfig.graphMeEndpoint, {
          headers: { Authorization: `Bearer ${response.accessToken}` },
        })
      })
      .then((res) => res.json())
      .then((me) => {
        setUser({
          displayName: me.displayName,
          firstName: me.givenName || me.displayName.split(' ')[0],
          email: me.mail || me.userPrincipalName,
          id: me.id,
        })
      })
      .catch((err) => {
        console.error('Failed to load user profile:', err)
        // Fall back to account info from MSAL cache
        setUser({
          displayName: account.name,
          firstName: account.name.split(' ')[0],
          email: account.username,
          id: account.localAccountId,
        })
      })
      .finally(() => setLoading(false))
  }, [accounts, instance])

  const login = () => instance.loginRedirect(loginRequest)
  const logout = () =>
    instance.logoutRedirect({ postLogoutRedirectUri: window.location.origin })

  return (
    <AuthContext.Provider value={{ user, loading, login, logout, isAuthenticated: !!user }}>
      {children}
    </AuthContext.Provider>
  )
}

export const useAuth = () => {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider')
  return ctx
}