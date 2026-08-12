function clean(value) {
  return String(value || '').trim()
}

function normalizeEntry(value) {
  if (value && typeof value === 'object') {
    return {
      name: clean(value.fullName || value.fullname || value.name),
      email: clean(value.email),
      phone: clean(value.phone),
      type: clean(value.type),
    }
  }
  const [name = '', email = '', phone = ''] = clean(value).split('|').map(clean)
  return { name, email, phone, type: '' }
}

export function parseSAMPOCs(value) {
  const entries = Array.isArray(value) ? value : clean(value).split(/\r?\n/).filter(Boolean)
  const unique = new Map()
  entries.map(normalizeEntry).forEach((contact) => {
    if (!contact.name && !contact.email && !contact.phone) return
    const key = contact.email.toLowerCase() || `${contact.name.toLowerCase()}|${contact.phone}`
    if (!unique.has(key)) unique.set(key, contact)
  })
  return [...unique.values()]
}

export function serializeSAMPOCs(value) {
  return parseSAMPOCs(value)
    .map((contact) => [contact.name, contact.email, contact.phone].filter(Boolean).join(' | '))
    .join('\n')
}

export function samPOCDisplayNames(value) {
  return parseSAMPOCs(value)
    .map((contact) => contact.name || contact.email || contact.phone)
    .filter(Boolean)
}
