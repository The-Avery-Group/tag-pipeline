// Explicit workbook grouping, never inferred from similar names or UEIs.
export function partnerGroupKey(partner) {
  const group = String(partner?.['Partner Group'] || '').trim()
  return group ? `group:${group.toLocaleLowerCase()}` : `entity:${partner?.['UEI Number'] || partner?._rowIndex}`
}

export function groupPartners(partners) {
  const groups = new Map()
  for (const partner of partners) {
    const key = partnerGroupKey(partner)
    if (!groups.has(key)) groups.set(key, { key, name: String(partner['Partner Group'] || partner['Partner Name'] || '').trim(), members: [] })
    groups.get(key).members.push(partner)
  }
  return [...groups.values()].sort((a, b) => a.name.localeCompare(b.name))
}

export function partnerProfilePath(partner) {
  return `/partners?partner=${encodeURIComponent(String(partner['UEI Number'] || '').trim())}`
}

export function sharedPartnerWorkspace(members) {
  const linked = members.filter(p => String(p['Link to Partner Folder'] || '').trim())
  const links = new Set(linked.map(p => String(p['Link to Partner Folder']).trim().replace(/\/$/, '')))
  // Conflicting folders are deliberately not merged or silently reassigned.
  return { partner: links.size === 1 ? linked[0] : null, conflict: links.size > 1 }
}
