const TABLE_IDENTITY_COLUMNS = {
  PipelineTable: ['Opportunity ID', 'Contract Number / Notice ID'],
  TasksTable: 'TaskID',
  NotesTable: 'NoteID',
  ContactsTable: 'ContactID',
  PartnersTable: ['Partner ID', 'UEI Number', 'Partner Name'],
  PartnerVehiclesTable: 'Record ID',
  ContactInteractionsTable: 'InteractionID',
  NewOpportunitiesTable: ['Notice ID', 'Solicitation Number'],
  EmailFollowUpTemplatesTable: 'Template ID',
  EmailFollowUpDraftsTable: 'Draft ID',
  SAMSettingsTable: 'Setting',
  RFIFollowUpOverridesTable: 'Opportunity ID',
  DataValidationTable: 'Key',
  ContractVehicleRulesTable: 'RULE_ID',
  TransactionCodingRulesTable: 'Rule ID',
  TransactionMappingsTable: 'Rule ID',
  OpportunityRelationshipsTable: 'Relationship ID',
}

export function recordIdentity(tableName, row) {
  if (!row) return ''
  if (tableName === 'RFIFollowUpDecisionsTable') {
    const parts = ['Opportunity ID', 'Follow-up Notice ID', 'Follow-up Solicitation Number'].map(key => String(row[key] || '').trim())
    return parts[0] && (parts[1] || parts[2]) ? JSON.stringify(parts) : ''
  }
  const configured = TABLE_IDENTITY_COLUMNS[tableName]
  const columns = Array.isArray(configured) ? configured : [configured]
  const normalized = value => String(value).toLowerCase().replace(/[^a-z0-9]/g, '')
  const column = columns.map(candidate => candidate && (Object.hasOwn(row, candidate) ? candidate : Object.keys(row).find(key => normalized(key) === normalized(candidate))))
    .find(candidate => candidate && String(row[candidate] || '').trim())
  return column ? String(row[column] || '').trim() : ''
}

// Row positions are transport hints, never an entity identifier. Capture this
// target before queuing a write so a later refresh cannot change its meaning.
export function mutationTarget(tableName, target, rows = []) {
  const identity = typeof target === 'string' ? target.trim() : recordIdentity(tableName, target)
  if (typeof target === 'number' || !identity) throw new Error(`A stable record ID is required for ${tableName}. Refresh and try again.`)
  const matches = rows.filter(row => recordIdentity(tableName, row) === identity)
  if (matches.length > 1) throw new Error(`Duplicate record ID in ${tableName}. Resolve the duplicate before saving.`)
  if (typeof target === 'object') {
    if (!Number.isInteger(target._rowIndex) && !matches.length) throw new Error(`Record not found in ${tableName}. Refresh and try again.`)
    return { ...matches[0], ...target, _rowIndex: target._rowIndex ?? matches[0]?._rowIndex }
  }
  if (!matches.length) throw new Error(`Record not found in ${tableName}. Refresh and try again.`)
  return matches[0]
}

export function sameRecord(tableName, row, target) {
  const identity = typeof target === 'string' ? target.trim() : recordIdentity(tableName, target)
  return Boolean(identity) && recordIdentity(tableName, row) === identity
}

export function externallyChangedPatchedFields(cached, current, patch) {
  if (!cached) return []
  return Object.keys(patch).filter((field) =>
    cached[field] !== current[field] && current[field] !== patch[field]
  )
}
