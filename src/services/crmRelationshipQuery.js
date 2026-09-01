const OPPORTUNITY_FIELDS = {
  id: 'Opportunity ID',
  contractNumber: 'Contract Number / Notice ID',
  title: 'Project Title / Description*',
  agency: 'Agency*',
  phase: 'TAG Opportunity Phase',
  endDate: 'Contract End Date*',
  value: 'Total Contract Value ($)*',
  pointOfContact: 'Contracting Officer / Specialist (POC)*',
  partner: 'Partner',
  archived: 'Archived',
}

function text(value) {
  return String(value || '').trim()
}

export function normalizeCrmRelationshipText(value) {
  return text(value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9@.+]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function includesPhrase(haystack, needle) {
  const normalizedHaystack = ` ${normalizeCrmRelationshipText(haystack)} `
  const normalizedNeedle = normalizeCrmRelationshipText(needle)
  return Boolean(normalizedNeedle) && normalizedHaystack.includes(` ${normalizedNeedle} `)
}

function isArchived(opportunity) {
  return /^(yes|true|1)$/i.test(text(opportunity?.[OPPORTUNITY_FIELDS.archived]))
}

function summarizeOpportunity(opportunity) {
  return {
    opportunityId: text(opportunity?.[OPPORTUNITY_FIELDS.id]),
    title: text(opportunity?.[OPPORTUNITY_FIELDS.title]),
    contractNumber: text(opportunity?.[OPPORTUNITY_FIELDS.contractNumber]),
    expiryDate: text(opportunity?.[OPPORTUNITY_FIELDS.endDate]),
    value: opportunity?.[OPPORTUNITY_FIELDS.value] ?? '',
    phase: text(opportunity?.[OPPORTUNITY_FIELDS.phase]),
    agency: text(opportunity?.[OPPORTUNITY_FIELDS.agency]),
    pointOfContact: text(opportunity?.[OPPORTUNITY_FIELDS.pointOfContact]),
    archived: isArchived(opportunity),
  }
}

function summarizeContact(contact) {
  return {
    contactId: text(contact?.ContactID),
    name: text(contact?.Name),
    title: text(contact?.Title),
    agency: text(contact?.Agency),
    organization: text(contact?.Organization),
    email: text(contact?.Email),
    phone: text(contact?.Phone),
  }
}

function tableUnavailable(readiness, tables) {
  const unavailable = tables.filter((table) => readiness?.[table] === false)
  return unavailable.length ? {
    status: 'data_unavailable',
    dataReady: false,
    unavailableTables: unavailable,
    message: `CRM data is still loading or unavailable: ${unavailable.join(', ')}`,
  } : null
}

function contactMatchesQuery(contact, query) {
  const normalized = normalizeCrmRelationshipText(query)
  if (!normalized) return false
  return [contact?.ContactID, contact?.Name, contact?.Title, contact?.Agency,
    contact?.Organization, contact?.Email, contact?.Phone]
    .some((value) => normalizeCrmRelationshipText(value).includes(normalized))
}

function opportunityReferencesContact(opportunity, contact) {
  const poc = opportunity?.[OPPORTUNITY_FIELDS.pointOfContact]
  const email = text(contact?.Email)
  return includesPhrase(poc, contact?.Name) || (email && normalizeCrmRelationshipText(poc).includes(normalizeCrmRelationshipText(email)))
}

function opportunityMatches(opportunity, query) {
  const normalized = normalizeCrmRelationshipText(query)
  return [
    opportunity?.[OPPORTUNITY_FIELDS.id],
    opportunity?.[OPPORTUNITY_FIELDS.contractNumber],
    opportunity?.[OPPORTUNITY_FIELDS.title],
  ].some((value) => normalizeCrmRelationshipText(value).includes(normalized))
}

function partnerMatchesOpportunity(partner, opportunity) {
  const linked = text(opportunity?.[OPPORTUNITY_FIELDS.partner])
  const name = text(partner?.['Partner Name'])
  const uei = text(partner?.['UEI Number'])
  return includesPhrase(linked, name) || (uei && normalizeCrmRelationshipText(linked).includes(normalizeCrmRelationshipText(uei)))
}

export function createCrmRelationshipQuery(data = {}) {
  const pipeline = Array.isArray(data.pipeline) ? data.pipeline : []
  const contacts = Array.isArray(data.contacts) ? data.contacts : []
  const tasks = Array.isArray(data.tasks) ? data.tasks : []
  const notes = Array.isArray(data.notes) ? data.notes : []
  const relationships = Array.isArray(data.relationships) ? data.relationships : []
  const partners = Array.isArray(data.partners) ? data.partners : []
  const interactions = Array.isArray(data.interactions) ? data.interactions : []
  const readiness = data.readiness || {}

  function searchContacts(query, limit = 8) {
    const unavailable = tableUnavailable(readiness, ['contacts'])
    if (unavailable) return unavailable
    const matches = contacts.filter((contact) => contactMatchesQuery(contact, query))
    return {
      status: 'ready', dataReady: true, count: matches.length,
      contacts: matches.slice(0, Math.min(Number(limit) || 8, 20)).map(summarizeContact),
    }
  }

  function getContactContracts({ query = '', contactId = '', email = '', includeArchived = false, limit = 50 } = {}) {
    const unavailable = tableUnavailable(readiness, ['contacts', 'pipeline'])
    if (unavailable) return unavailable
    const normalizedId = normalizeCrmRelationshipText(contactId)
    const normalizedEmail = normalizeCrmRelationshipText(email)
    let matches = contacts.filter((contact) => {
      if (normalizedId) return normalizeCrmRelationshipText(contact.ContactID) === normalizedId
      if (normalizedEmail) return normalizeCrmRelationshipText(contact.Email) === normalizedEmail
      return contactMatchesQuery(contact, query)
    })
    if (matches.length > 1 && query) {
      const exactName = matches.filter((contact) => normalizeCrmRelationshipText(contact.Name) === normalizeCrmRelationshipText(query))
      if (exactName.length) matches = exactName
    }
    if (!matches.length) {
      return { status: 'not_found', dataReady: true, contactFound: false, query, contacts: [] }
    }

    const linked = pipeline.filter((opportunity) =>
      (includeArchived || !isArchived(opportunity)) && matches.some((contact) => opportunityReferencesContact(opportunity, contact))
    )
    return {
      status: matches.length > 1 ? 'ambiguous' : 'ready',
      dataReady: true,
      contactFound: true,
      ambiguous: matches.length > 1,
      contacts: matches.map(summarizeContact),
      linkedOpportunityCount: linked.length,
      opportunities: linked.slice(0, Math.min(Number(limit) || 50, 100)).map(summarizeOpportunity),
    }
  }

  function getOpportunityRelationships(query, limit = 25) {
    const unavailable = tableUnavailable(readiness, ['pipeline'])
    if (unavailable) return unavailable
    const opportunity = pipeline.find((item) => opportunityMatches(item, query))
    if (!opportunity) return { status: 'not_found', dataReady: true, opportunityFound: false, query }

    const contractNumber = text(opportunity[OPPORTUNITY_FIELDS.contractNumber])
    const opportunityId = text(opportunity[OPPORTUNITY_FIELDS.id])
    const relatedIds = new Set()
    relationships.forEach((relationship) => {
      const left = text(relationship['Opportunity ID'])
      const right = text(relationship['Related Opportunity ID'])
      if (left === opportunityId && right) relatedIds.add(right)
      if (right === opportunityId && left) relatedIds.add(left)
    })
    const linkedContacts = contacts.filter((contact) => opportunityReferencesContact(opportunity, contact))
    const linkedInteractions = interactions.filter((interaction) =>
      linkedContacts.some((contact) => text(contact.ContactID) === text(interaction.ContactID))
    )
    return {
      status: 'ready',
      dataReady: true,
      opportunityFound: true,
      opportunity: summarizeOpportunity(opportunity),
      contacts: linkedContacts.map(summarizeContact),
      tasks: tasks.filter((task) => text(task.ContractNumber) === contractNumber).slice(0, limit),
      notes: notes.filter((note) => text(note.ContractNumber) === contractNumber && !text(note.NoteText).startsWith('[TAG_RELATED_OPPORTUNITY]')).slice(0, limit),
      relatedOpportunities: pipeline.filter((item) => relatedIds.has(text(item[OPPORTUNITY_FIELDS.id]))).map(summarizeOpportunity),
      partners: partners.filter((partner) => partnerMatchesOpportunity(partner, opportunity)).slice(0, limit),
      contactInteractions: linkedInteractions.slice(0, limit),
    }
  }

  return { searchContacts, getContactContracts, getOpportunityRelationships }
}

export function queryCrmRelationships(data, args = {}) {
  const query = createCrmRelationshipQuery(data)
  if (args.entityType === 'contact') {
    return query.getContactContracts({
      query: args.query,
      contactId: args.contactId,
      email: args.email,
      includeArchived: Boolean(args.includeArchived),
      limit: args.limit,
    })
  }
  if (args.entityType === 'opportunity') return query.getOpportunityRelationships(args.query, args.limit)
  return { status: 'invalid_request', dataReady: true, error: 'entityType must be contact or opportunity' }
}
