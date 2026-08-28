const INVALID_SHAREPOINT_CHARS = /["*:<>?/\\|#%]/g
const ACRONYM_STOP_WORDS = new Set(['AND', 'FOR', 'OF', 'THE'])
const ORGANIZATION_STOP_WORDS = new Set(['AND', 'FOR', 'OF', 'THE', 'US', 'UNITED', 'STATES'])
const ORGANIZATION_ALIASES = new Map([
  ['ASFR', 'ASSISTANT SECRETARY FINANCIAL RESOURCES'],
  ['CDC', 'CENTERS DISEASE CONTROL PREVENTION'],
  ['DCSA', 'DEFENSE COUNTERINTELLIGENCE SECURITY AGENCY'],
  ['DHA', 'DEFENSE HEALTH AGENCY'],
  ['DOD', 'DEPARTMENT DEFENSE'],
  ['DODEA', 'DEPARTMENT DEFENSE EDUCATION ACTIVITY'],
  ['DOW', 'DEPARTMENT DEFENSE'],
  ['DOWEA', 'DEPARTMENT DEFENSE EDUCATION ACTIVITY'],
  ['DOS', 'DEPARTMENT STATE'],
  ['HHS', 'DEPARTMENT HEALTH HUMAN SERVICES'],
  ['NASA', 'NATIONAL AERONAUTICS SPACE ADMINISTRATION'],
  ['NIH', 'NATIONAL INSTITUTES HEALTH'],
  ['ARMY', 'DEPARTMENT ARMY'],
  ['DEPARTMENT OF WAR', 'DEPARTMENT DEFENSE'],
  ['DEPARTMENT OF WAR EDUCATION ACTIVITY', 'DEPARTMENT DEFENSE EDUCATION ACTIVITY'],
  ['VA', 'DEPARTMENT VETERANS AFFAIRS'],
])

const AGENCY_ALIASES = new Map([
  ['DEPARTMENT OF DEFENSE EDUCATION ACTIVITY', 'DODEA'],
  ['DEPARTMENT OF DEFENSE EDUCATION ACTIVITY DODEA', 'DODEA'],
  ['DOD EDUCATION ACTIVITY', 'DODEA'],
  ['DODEA', 'DODEA'],
  ['CENTERS FOR DISEASE CONTROL AND PREVENTION', 'CDC'],
  ['CENTERS FOR DISEASE CONTROL AND PREVENTION CDC', 'CDC'],
  ['DEFENSE COUNTERINTELLIGENCE AND SECURITY AGENCY', 'DCSA'],
  ['DEFENSE HEALTH AGENCY', 'DHA'],
  ['NATIONAL AERONAUTICS AND SPACE ADMINISTRATION', 'NASA'],
  ['NATIONAL INSTITUTES OF HEALTH', 'NIH'],
  ['DEPARTMENT OF VETERANS AFFAIRS', 'VA'],
  ['VETERANS AFFAIRS DEPARTMENT OF', 'VA'],
  ['DEPARTMENT OF THE ARMY', 'ARMY'],
  ['DEPT OF THE ARMY', 'ARMY'],
  ['ARMY', 'ARMY'],
  ['ASSISTANT SECRETARY FOR FINANCIAL RESOURCES', 'ASFR'],
])

export function normalizeWorkspaceKey(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').toUpperCase()
}

export function safeSharePointSegment(value, fallback = 'Untitled', maxLength = 120) {
  const cleaned = String(value || fallback)
    .replace(INVALID_SHAREPOINT_CHARS, '_')
    .replace(/[. ]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return (cleaned || fallback).slice(0, maxLength).replace(/[. ]+$/g, '') || fallback
}

function normalizedAgencyName(value) {
  return String(value || '')
    .replace(/&/g, ' AND ')
    .replace(/\bU\.?S\.?\b/gi, 'US')
    .replace(/[^a-z0-9]+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase()
}

export function organizationFolderKey(value) {
  const withoutAcronymSuffix = String(value || '').replace(/\([A-Z][A-Z0-9&.\s-]{1,14}\)/g, ' ')
  let normalized = normalizedAgencyName(withoutAcronymSuffix)
  if (!normalized) return ''
  if (ORGANIZATION_ALIASES.has(normalized)) normalized = ORGANIZATION_ALIASES.get(normalized)
  const tokens = normalized
    .split(' ')
    .map((token) => token === 'DEPT' ? 'DEPARTMENT' : token)
    .filter((token) => token && !ORGANIZATION_STOP_WORDS.has(token))
  return [...new Set(tokens)].sort().join('|')
}

export function agencyAbbreviation(value) {
  const normalized = normalizedAgencyName(value)
  if (!normalized) return 'AGENCY'
  if (AGENCY_ALIASES.has(normalized)) return AGENCY_ALIASES.get(normalized)

  const parenthetical = String(value || '').match(/\(([A-Z][A-Z0-9]{1,9})\)/)
  if (parenthetical) return parenthetical[1]

  const words = normalized.split(' ').filter((word) => !ACRONYM_STOP_WORDS.has(word))
  if (words.length === 1 && words[0].length <= 10) return words[0]
  const acronym = words.map((word) => word[0]).join('').slice(0, 10)
  return acronym || 'AGENCY'
}

export function opportunityWorkspaceFolderName({ agency, title }) {
  const prefix = agencyAbbreviation(agency)
  const availableForTitle = Math.max(20, 120 - prefix.length - 1)
  return safeSharePointSegment(`${prefix}_${safeSharePointSegment(title, 'Untitled opportunity', availableForTitle)}`)
}

export function workspaceCalendarYear(value, fallbackDate = new Date()) {
  const numeric = Number(value)
  if (Number.isInteger(numeric) && numeric >= 2000 && numeric <= 2100) return numeric
  return fallbackDate.getFullYear()
}

export function workspaceType(value) {
  const normalized = String(value || '').trim().toUpperCase()
  if (normalized.includes('MRAS')) return 'MRAS'
  if (normalized.includes('RFQ') || normalized === 'K') return 'RFQ'
  if (normalized.includes('RFP') || normalized === 'O' || normalized === 'P') return 'RFP'
  return 'RFI'
}
