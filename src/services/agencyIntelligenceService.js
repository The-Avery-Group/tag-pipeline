import { workerJson } from '@/services/workerClient'

function queryString(values) {
  const params = new URLSearchParams()
  Object.entries(values).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') params.set(key, String(value))
  })
  return params.toString()
}

export function searchOfficialAgencies(query, { signal, limit = 12 } = {}) {
  return workerJson(`/agency-intelligence/agencies?${queryString({ q: query, limit })}`, { signal })
}

export function getAgencyVehicles(agency, { page = 1, limit = 50, forceRefresh = false, signal } = {}) {
  return workerJson(`/agency-intelligence/vehicles?${queryString({
    name: agency?.name,
    tier: agency?.tier,
    parent: agency?.parentName,
    code: agency?.toptierCode,
    page,
    limit,
    refresh: forceRefresh ? 1 : '',
  })}`, { signal })
}

export function getVehicleActivity(awardId, { forceRefresh = false, signal } = {}) {
  return workerJson(`/agency-intelligence/vehicle?${queryString({
    awardId,
    refresh: forceRefresh ? 1 : '',
  })}`, { signal })
}
