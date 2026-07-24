export function needsRfiActivityPhasePrompt(existing, next, columns) {
  return next[columns.phase] === 'Identified' &&
    next[columns.outlook] === 'New' &&
    !existing[columns.submissionDate] &&
    Boolean(next[columns.submissionDate]) &&
    !next[columns.activityPhase]
}
