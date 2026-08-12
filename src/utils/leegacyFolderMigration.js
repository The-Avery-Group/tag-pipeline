const STOP_WORDS = new Set(['a', 'an', 'and', 'for', 'in', 'of', 'on', 'the', 'to', 'with'])

export function normalizeMigrationText(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, ' and ')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
}

function compact(value) {
  return normalizeMigrationText(value).replace(/\s+/g, '')
}

function tokens(value) {
  return new Set(normalizeMigrationText(value).split(' ').filter((token) => token.length > 1 && !STOP_WORDS.has(token)))
}

function overlap(left, right) {
  const a = tokens(left)
  const b = tokens(right)
  if (!a.size || !b.size) return 0
  let shared = 0
  a.forEach((token) => { if (b.has(token)) shared += 1 })
  return shared / Math.min(a.size, b.size)
}

function hierarchyMatch(left, right) {
  const a = normalizeMigrationText(left)
  const b = normalizeMigrationText(right)
  if (!a || !b) return 0
  if (a === b || a.includes(b) || b.includes(a)) return 1
  return overlap(a, b)
}

function linkFolderName(link) {
  if (!link) return ''
  try {
    const url = new URL(link)
    const path = decodeURIComponent(url.pathname).split('/').filter(Boolean)
    return path.at(-1) || ''
  } catch {
    return ''
  }
}

function opportunityYear(opportunity) {
  return String(opportunity?.['Fiscal Year'] || '').match(/20\d{2}/)?.[0] || ''
}

function folderYear(folder) {
  return String(folder?.year || '').match(/20\d{2}/)?.[0] || ''
}

export function scoreLegacyFolder(opportunity, folder) {
  const contractNumber = compact(opportunity?.['Contract Number / Notice ID'])
  const solicitationNumber = compact(opportunity?.['Solicitation Number'])
  const searchablePath = compact(`${folder?.path || ''} ${folder?.name || ''}`)
  if ((contractNumber.length >= 5 && searchablePath.includes(contractNumber)) ||
      (solicitationNumber.length >= 5 && searchablePath.includes(solicitationNumber))) {
    return { score: 100, reason: 'Contract or solicitation ID matches' }
  }

  const currentFolder = compact(linkFolderName(opportunity?.['Link to Folder']))
  if (currentFolder.length >= 5 && currentFolder === compact(folder?.name)) {
    return { score: 98, reason: 'Existing folder name matches' }
  }

  const title = opportunity?.['Project Title / Description*'] || ''
  const titleCompact = compact(title)
  const folderCompact = compact(folder?.name)
  const titleOverlap = overlap(title, folder?.name)
  const agencyMatch = hierarchyMatch(opportunity?.['Agency*'], folder?.agency)
  const departmentMatch = hierarchyMatch(opportunity?.['Department*'], folder?.department)
  const year = opportunityYear(opportunity)
  const sameYear = Boolean(year && year === folderYear(folder))

  let score = Math.round(titleOverlap * 70)
  if (titleCompact.length >= 8 && (folderCompact.includes(titleCompact) || titleCompact.includes(folderCompact))) score = Math.max(score, 82)
  if (agencyMatch >= 0.65) score += 10
  if (departmentMatch >= 0.65) score += 5
  if (sameYear) score += 3
  return {
    score: Math.min(97, score),
    reason: [
      titleOverlap >= 0.8 ? 'title' : titleOverlap >= 0.6 ? 'partial title' : null,
      agencyMatch >= 0.65 ? 'agency' : null,
      departmentMatch >= 0.65 ? 'department' : null,
      sameYear ? 'year' : null,
    ].filter(Boolean).join(', ') || 'Limited identifying information',
  }
}

function sameFolderLink(left, right) {
  const normalizeLink = (value) => String(value || '').trim().replace(/\/$/, '').toLowerCase()
  return Boolean(normalizeLink(left) && normalizeLink(left) === normalizeLink(right))
}

function confidenceFor(score, ambiguous) {
  if (ambiguous) return 'ambiguous'
  if (score >= 98) return 'exact'
  if (score >= 82) return 'high'
  if (score >= 65) return 'possible'
  return 'unmatched'
}

export function buildLegacyFolderMatches(opportunities, folders) {
  return (opportunities || []).map((opportunity) => {
    const currentLink = String(opportunity?.['Link to Folder'] || '').trim()
    const ranked = (folders || []).map((folder) => ({ folder, ...scoreLegacyFolder(opportunity, folder) }))
      .sort((left, right) => right.score - left.score || left.folder.path.localeCompare(right.folder.path))
    const best = ranked[0] || null
    const second = ranked[1] || null
    const ambiguous = Boolean(best && best.score >= 65 && second && second.score >= best.score - 4)
    // A legacy OneDrive link is also hosted on a sharepoint.com domain. Only
    // treat the record as migrated when it matches a folder found in the
    // configured destination archive.
    const alreadyLinkedFolder = (folders || []).find((folder) => sameFolderLink(currentLink, folder.webUrl))
    const alreadyLinked = Boolean(alreadyLinkedFolder)
    const confidence = alreadyLinked ? 'linked' : confidenceFor(best?.score || 0, ambiguous)
    const selectedFolderId = alreadyLinked ? '' : best?.score >= 65 && !ambiguous ? best.folder.id : ''
    return {
      contractNumber: String(opportunity?.['Contract Number / Notice ID'] || '').trim(),
      title: String(opportunity?.['Project Title / Description*'] || '').trim() || 'Untitled opportunity',
      agency: String(opportunity?.['Agency*'] || '').trim(),
      currentLink,
      confidence,
      reason: alreadyLinked ? 'Already linked to SharePoint' : best?.reason || 'No folder candidates found',
      score: best?.score || 0,
      selectedFolderId,
      approved: ['exact', 'high'].includes(confidence),
      candidates: ranked.slice(0, 8),
    }
  })
}

export function migrationConfidenceLabel(value) {
  return ({
    exact: 'Exact', high: 'High', possible: 'Possible', ambiguous: 'Ambiguous', unmatched: 'Unmatched', linked: 'Already linked', manual: 'Selected manually',
  })[value] || value
}
