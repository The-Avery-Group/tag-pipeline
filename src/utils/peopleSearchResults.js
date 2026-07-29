const CURRENT_ROLE_PATTERN = /\b(current|currently|present)\b/i
const EXPLICIT_FORMER_ROLE_PATTERN = /\b(former|formerly|previously|retired)\b/i
const CLOSED_YEAR_RANGE_PATTERN = /\b(?:19|20)\d{2}\s*(?:-|–|—|to)\s*(?:19|20)\d{2}\b/i

export function possibleFormerRoleReason(result = {}) {
  const visibleText = `${result.title || ''} ${result.snippet || ''}`.trim()
  if (!visibleText) return ''

  if (EXPLICIT_FORMER_ROLE_PATTERN.test(visibleText)) {
    return 'The public result describes this person as former, previous, or retired.'
  }

  if (CLOSED_YEAR_RANGE_PATTERN.test(visibleText) && !CURRENT_ROLE_PATTERN.test(visibleText)) {
    return 'The public result shows a role with a past end year.'
  }

  return ''
}
