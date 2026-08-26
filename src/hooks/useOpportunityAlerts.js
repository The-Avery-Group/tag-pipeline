import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  acknowledgeOpportunityAlert as acknowledgeAlert,
  getOpportunityAlerts,
} from '@/services/opportunityAlertService'

export function useOpportunityAlerts(opportunityKey = '', { enabled = true } = {}) {
  const [alerts, setAlerts] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const load = useCallback(async ({ silent = false } = {}) => {
    if (!enabled) { setLoading(false); return }
    if (!silent) setLoading(true)
    try {
      const data = await getOpportunityAlerts(opportunityKey)
      setAlerts(opportunityKey ? (data.alerts || []) : (data.alerts || []).filter((alert) => alert.badgeVisible))
      setError(null)
    } catch (err) {
      setError(err.message)
    } finally {
      if (!silent) setLoading(false)
    }
  }, [opportunityKey, enabled])

  useEffect(() => { load() }, [load])
  useEffect(() => {
    if (!enabled) return undefined
    const timer = window.setInterval(() => load({ silent: true }), 5 * 60 * 1000)
    return () => window.clearInterval(timer)
  }, [load, enabled])

  const acknowledge = useCallback(async (type, fingerprint = '') => {
    const data = await acknowledgeAlert(opportunityKey, type, fingerprint)
    setAlerts((current) => current.map((alert) =>
      alert.type === type ? data.alert : alert
    ))
    return data.alert
  }, [opportunityKey])

  const byType = useMemo(() => Object.fromEntries(alerts.map((alert) => [alert.type, alert])), [alerts])
  return { alerts, byType, loading, error, refresh: load, acknowledge }
}
