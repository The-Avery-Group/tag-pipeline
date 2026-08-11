function clean(value) {
  return String(value || '').trim()
}

function nameCode(name) {
  const parts = clean(name).toUpperCase().replace(/[^A-Z ]/g, ' ').split(/\s+/).filter(Boolean)
  if (parts.length < 2) return ''
  return `${parts[0][0]}${parts[parts.length - 1]}`
}

function isHhsIdentifierAgency(agencyName) {
  const agency = clean(agencyName).toUpperCase()
  return agency.includes('CENTERS FOR DISEASE') ||
    agency.includes('NATIONAL INSTITUTES OF HEALTH') ||
    agency.includes('ASSISTANT SECRETARY FOR FINANCIAL')
}

function crmMatches(rawValue, agencyName, contacts) {
  const raw = clean(rawValue)
  if (!raw) return []
  const rawEmail = raw.toLowerCase()
  const hhsCode = isHhsIdentifierAgency(agencyName) && raw.toUpperCase().startsWith('HHS')
    ? raw.toUpperCase().slice(3)
    : ''

  return (Array.isArray(contacts) ? contacts : []).filter((contact) => {
    if (hhsCode) return nameCode(contact?.Name) === hhsCode
    return raw.includes('@') && clean(contact?.Email).toLowerCase() === rawEmail
  }).map((contact) => ({
    name: clean(contact.Name),
    email: clean(contact.Email),
    agency: clean(contact.Agency || contact.Organization),
    contactId: clean(contact.ContactID),
    sourceLabel: 'CRM contacts',
  }))
}

function matchKey(match) {
  return clean(match.email).toLowerCase() || clean(match.name).toLowerCase()
}

export function resolveModifierWithCrmContacts(resolution, agencyName, contacts) {
  const base = resolution || {}
  if (!base.raw || base.status === 'system' || base.status === 'empty') return base
  const matches = []
  const seen = new Set()
  ;(Array.isArray(base.matches) ? base.matches : []).forEach((match) => {
    const key = matchKey(match)
    if (!key || seen.has(key)) return
    seen.add(key)
    matches.push({ ...match, sourceLabel: match.noticeId ? `public notice ${match.noticeId}` : 'public notice' })
  })
  crmMatches(base.raw, agencyName, contacts).forEach((match) => {
    const key = matchKey(match)
    if (!key || seen.has(key)) return
    seen.add(key)
    matches.push(match)
  })

  if (matches.length === 1) return { ...base, status: 'matched', matches }
  if (matches.length > 1) return { ...base, status: 'multiple', matches }
  return { ...base, status: 'unresolved', matches: [] }
}
