const TABLE_IDENTITY_COLUMNS = {
  PipelineTable: ['Opportunity ID', 'Contract Number / Notice ID'],
  TasksTable: 'TaskID',
  NotesTable: 'NoteID',
  ContactsTable: 'ContactID',
  PartnersTable: 'UEI Number',
  ContactInteractionsTable: 'InteractionID',
  NewOpportunitiesTable: ['Notice ID', 'Solicitation Number'],
  EmailFollowUpTemplatesTable: 'Template ID',
  EmailFollowUpDraftsTable: 'Draft ID',
  SAMSettingsTable: 'Setting',
  RFIFollowUpOverridesTable: 'Opportunity ID',
}

export function recordIdentity(tableName, row) {
  if (!row) return ''
  const configured = TABLE_IDENTITY_COLUMNS[tableName]
  const columns = Array.isArray(configured) ? configured : [configured]
  const column = columns.find((candidate) => candidate && String(row[candidate] || '').trim())
  return column ? String(row[column] || '').trim() : ''
}

export function externallyChangedPatchedFields(cached, current, patch) {
  if (!cached) return []
  return Object.keys(patch).filter((field) =>
    cached[field] !== current[field] && current[field] !== patch[field]
  )
}
