import { useCallback, useEffect, useRef, useState } from 'react'
import { workerJson } from '@/services/workerClient'

const POLL_MS = 2500

export function useExpiringContracts(range = '6-12', agencyIds = []) {
  const [config, setConfig] = useState({ agencies: [], ranges: ['6-12', '12-18', '18-24'] })
  const [contracts, setContracts] = useState([])
  const [agencyStatus, setAgencyStatus] = useState([])
  const [status, setStatus] = useState({ status: 'idle' })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const timerRef = useRef(null)

  const loadResults = useCallback(async () => {
    const params = new URLSearchParams({ range })
    if (agencyIds.length) params.set('agencies', agencyIds.join(','))
    const payload = await workerJson(`/sam/expiring-contracts/results?${params}`)
    setContracts(payload.contracts || [])
    setAgencyStatus(payload.agencies || [])
    return payload
  }, [agencyIds.join(','), range])

  const loadStatus = useCallback(async () => {
    const payload = await workerJson('/sam/expiring-contracts/status', { cache: 'no-store' })
    setStatus(payload)
    return payload
  }, [])

  useEffect(() => {
    let active = true
    setLoading(true)
    Promise.all([
      workerJson('/sam/expiring-contracts/config'),
      loadResults(),
      loadStatus(),
    ]).then(([nextConfig]) => {
      if (!active) return
      setConfig(nextConfig)
      setError('')
    }).catch((nextError) => {
      if (active) setError(nextError.message)
    }).finally(() => {
      if (active) setLoading(false)
    })
    return () => { active = false }
  }, [loadResults, loadStatus])

  useEffect(() => {
    clearInterval(timerRef.current)
    if (!['queued', 'running'].includes(status.status)) return undefined
    timerRef.current = setInterval(async () => {
      try {
        const next = await loadStatus()
        if (next.status === 'success') await loadResults()
      } catch (nextError) {
        setError(nextError.message)
      }
    }, POLL_MS)
    return () => clearInterval(timerRef.current)
  }, [loadResults, loadStatus, status.status])

  const refresh = useCallback(async (agencies) => {
    setError('')
    const result = await workerJson('/sam/expiring-contracts/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agencies }),
    })
    setStatus((current) => ({ ...current, status: 'queued', runId: result.runId }))
    return result
  }, [])

  const loadDetail = useCallback(async (contract, { refresh: force = false } = {}) => {
    const params = new URLSearchParams({ piid: contract.piid })
    if (contract.incumbentUEI) params.set('uei', contract.incumbentUEI)
    if (force) params.set('refresh', '1')
    return workerJson(`/sam/expiring-contracts/detail?${params}`, { cache: 'no-store' })
  }, [])

  return { config, contracts, agencyStatus, status, loading, error, refresh, loadResults, loadDetail }
}
