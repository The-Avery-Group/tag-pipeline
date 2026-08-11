import { useCallback, useEffect, useRef, useState } from 'react'
import { workerJson } from '@/services/workerClient'

const POLL_MS = 2500

export function useExpiringContracts(range = '6-12', agencyIds = [], includeHidden = false) {
  const [config, setConfig] = useState({ agencies: [], ranges: ['6-12', '12-18', '18-24'] })
  const [contracts, setContracts] = useState([])
  const [agencyStatus, setAgencyStatus] = useState([])
  const [hiddenCount, setHiddenCount] = useState(0)
  const [status, setStatus] = useState({ status: 'idle' })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const timerRef = useRef(null)
  const refreshPromiseRef = useRef(null)

  const loadResults = useCallback(async () => {
    const params = new URLSearchParams({ range })
    if (agencyIds.length) params.set('agencies', agencyIds.join(','))
    if (includeHidden) params.set('includeHidden', '1')
    const payload = await workerJson(`/sam/expiring-contracts/results?${params}`)
    setContracts(payload.contracts || [])
    setAgencyStatus(payload.agencies || [])
    setHiddenCount(Number(payload.hiddenCount || 0))
    return payload
  }, [agencyIds.join(','), includeHidden, range])

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
        if (['success', 'partial'].includes(next.status)) await loadResults()
      } catch (nextError) {
        setError(nextError.message)
      }
    }, POLL_MS)
    return () => clearInterval(timerRef.current)
  }, [loadResults, loadStatus, status.status])

  const refresh = useCallback(async (agencies) => {
    if (refreshPromiseRef.current) return refreshPromiseRef.current
    setError('')
    const operation = workerJson('/sam/expiring-contracts/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agencies }),
        keepalive: true,
      })
      .then((result) => {
        setStatus((current) => ({ ...current, status: 'queued', runId: result.runId }))
        return result
      })
      .finally(() => {
        refreshPromiseRef.current = null
      })
    refreshPromiseRef.current = operation
    return operation
  }, [])

  const loadDetail = useCallback(async (contract, { refresh: force = false } = {}) => {
    const params = new URLSearchParams({ piid: contract.piid })
    if (contract.incumbentUEI) params.set('uei', contract.incumbentUEI)
    if (force) params.set('refresh', '1')
    return workerJson(`/sam/expiring-contracts/detail?${params}`, { cache: 'no-store' })
  }, [])

  const resolveAgencies = useCallback(async (query) => {
    const params = new URLSearchParams({ q: query })
    const payload = await workerJson(`/sam/expiring-contracts/agencies/resolve?${params}`, { cache: 'no-store' })
    return payload.agencies || []
  }, [])

  const saveAgency = useCallback(async (agency) => {
    const payload = await workerJson('/sam/expiring-contracts/agencies', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agency }),
    })
    setConfig((current) => ({ ...current, agencies: payload.agencies || current.agencies }))
    return payload.agencies || []
  }, [])

  const removeAgency = useCallback(async (agencyId) => {
    const params = new URLSearchParams({ id: agencyId })
    const payload = await workerJson(`/sam/expiring-contracts/agencies?${params}`, { method: 'DELETE' })
    setConfig((current) => ({ ...current, agencies: payload.agencies || current.agencies }))
    return payload.agencies || []
  }, [])

  const setContractHidden = useCallback(async (familyKey, hidden) => {
    const previousContracts = contracts
    const previousHiddenCount = hiddenCount
    setContracts((current) => hidden
      ? (includeHidden
          ? current.map((contract) => contract.familyKey === familyKey ? { ...contract, hidden: true } : contract)
          : current.filter((contract) => contract.familyKey !== familyKey))
      : current.map((contract) => contract.familyKey === familyKey ? { ...contract, hidden: false } : contract))
    setHiddenCount((current) => Math.max(0, current + (hidden ? 1 : -1)))
    try {
      return await workerJson('/sam/expiring-contracts/visibility', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ familyKey, hidden }),
      })
    } catch (error) {
      setContracts(previousContracts)
      setHiddenCount(previousHiddenCount)
      throw error
    }
  }, [contracts, hiddenCount, includeHidden])

  return {
    config,
    contracts,
    agencyStatus,
    hiddenCount,
    status,
    loading,
    error,
    refresh,
    loadResults,
    loadDetail,
    resolveAgencies,
    saveAgency,
    removeAgency,
    setContractHidden,
  }
}
