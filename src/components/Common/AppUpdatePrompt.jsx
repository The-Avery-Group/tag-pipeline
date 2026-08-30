import { useCallback, useEffect, useRef, useState } from 'react'
import Modal from '@/components/Common/Modal'
import {
  APP_VERSION_POLL_MS,
  CURRENT_APP_VERSION,
  createAppUpdateDeferral,
  fetchDeployedAppVersion,
  isAppUpdateDeferred,
  isNewerAppVersion,
  reloadWithCacheBypass,
} from '@/services/appUpdateService'

const DISMISSED_UPDATE_KEY = 'tag_crm_dismissed_update'

function deferredUpdate() {
  try {
    const stored = sessionStorage.getItem(DISMISSED_UPDATE_KEY)
    return stored ? JSON.parse(stored) : null
  } catch { return null }
}

export default function AppUpdatePrompt() {
  const [availableVersion, setAvailableVersion] = useState(null)
  const checkingRef = useRef(false)

  const checkForUpdate = useCallback(async () => {
    if (checkingRef.current) return
    checkingRef.current = true
    try {
      const deployed = await fetchDeployedAppVersion()
      if (isNewerAppVersion(deployed, CURRENT_APP_VERSION) && !isAppUpdateDeferred(deferredUpdate(), deployed.buildId)) {
        setAvailableVersion(deployed)
      }
    } catch {
      // Deployment checks are intentionally quiet when offline or while
      // GitHub Pages is between releases. The next interval/focus retries it.
    } finally {
      checkingRef.current = false
    }
  }, [])

  useEffect(() => {
    checkForUpdate()
    const interval = window.setInterval(checkForUpdate, APP_VERSION_POLL_MS)
    const onFocus = () => checkForUpdate()
    const onVisibility = () => { if (document.visibilityState === 'visible') checkForUpdate() }
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.clearInterval(interval)
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [checkForUpdate])

  if (!availableVersion) return null

  const postpone = () => {
    try { sessionStorage.setItem(DISMISSED_UPDATE_KEY, JSON.stringify(createAppUpdateDeferral(availableVersion.buildId))) } catch {}
    setAvailableVersion(null)
  }

  return (
    <Modal
      title="TAG CRM update available"
      onClose={postpone}
      footer={<>
        <button type="button" className="btn" onClick={postpone}>Remind me in 1 hour</button>
        <button type="button" className="btn btn-primary" autoFocus onClick={() => reloadWithCacheBypass(availableVersion.buildId)}>
          Reload now
        </button>
      </>}
    >
      <p className="text-sm" style={{ margin: 0, color: 'var(--gray-600)', lineHeight: 1.6 }}>
        A newer version of TAG CRM is ready. Reload now to apply the update and return to this page.
      </p>
    </Modal>
  )
}
