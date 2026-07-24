const TABLE_IDENTITY_COLUMNS = {
  PipelineTable: 'Contract Number / Notice ID',
  TasksTable: 'TaskID',
  NotesTable: 'NoteID',
  ContactsTable: 'ContactID',
  PartnersTable: 'UEI Number',
  ContactInteractionsTable: 'InteractionID',
  NewOpportunitiesTable: 'Notice ID',
}

export function recordIdentity(tableName, row) {
  if (!row) return ''
  const column = TABLE_IDENTITY_COLUMNS[tableName]
  return column ? String(row[column] || '').trim() : ''
}

export function externallyChangedPatchedFields(cached, current, patch) {
  if (!cached) return []
  return Object.keys(patch).filter((field) => cached[field] !== current[field])
}
