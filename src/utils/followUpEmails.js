const clean = (value) => String(value ?? '').trim()

export function formatRecipientNames(names = []) {
  const unique = [...new Set(names.map(clean).filter(Boolean))]
  if (unique.length < 2) return unique[0] || ''
  if (unique.length === 2) return `${unique[0]} and ${unique[1]}`
  return `${unique.slice(0, -1).join(', ')}, and ${unique.at(-1)}`
}

export const FOLLOW_UP_MERGE_FIELDS = [
  '{{contact_first_name}}',
  '{{opportunity_title}}',
  '{{notice_id}}',
  '{{agency}}',
  '{{submission_date}}',
  '{{days_since_submission}}',
  '{{sam_url}}',
]

export function isoDate(value) {
  const match = clean(value).match(/^(\d{4})-(\d{2})-(\d{2})/)
  return match ? `${match[1]}-${match[2]}-${match[3]}` : ''
}

export function addDays(value, days) {
  const date = new Date(`${isoDate(value)}T00:00:00Z`)
  if (Number.isNaN(date.getTime())) return ''
  date.setUTCDate(date.getUTCDate() + Number(days || 0))
  return date.toISOString().slice(0, 10)
}

function todayInLagos(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Africa/Lagos',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date)
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  return `${values.year}-${values.month}-${values.day}`
}

export function deterministicDraftId(opportunityId, templateId) {
  return `FU-${clean(opportunityId).toLowerCase()}-${clean(templateId).toLowerCase()}`
    .replace(/[^a-z0-9:_-]+/g, '-')
    .slice(0, 180)
}

export function mergeFollowUpTemplate(value, context = {}) {
  const replacements = {
    contact_first_name: clean(context.contactFirstName),
    opportunity_title: clean(context.opportunityTitle),
    notice_id: clean(context.noticeId),
    agency: clean(context.agency),
    submission_date: isoDate(context.submissionDate),
    days_since_submission: clean(context.daysSinceSubmission),
    sam_url: clean(context.samUrl),
  }
  return clean(value).replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (match, key) =>
    Object.hasOwn(replacements, key.toLowerCase()) ? replacements[key.toLowerCase()] : match
  )
}

export function buildFollowUpDraft({ opportunity, template, recipient = '', cc = '', user = '', source = 'Manual' }) {
  const opportunityId = clean(opportunity['Contract Number / Notice ID'])
  const templateId = clean(template['Template ID'])
  const milestoneDays = Number(template['Days After Submission'] || 0)
  const submissionDate = isoDate(opportunity['Submission Date (Response Date)*'])
  const dueDate = addDays(submissionDate, milestoneDays)
  const today = todayInLagos()
  const context = {
    contactFirstName: clean(opportunity.contactFirstName),
    opportunityTitle: opportunity['Project Title / Description*'],
    noticeId: opportunityId,
    agency: opportunity['Agency*'],
    submissionDate,
    daysSinceSubmission: milestoneDays,
    samUrl: opportunity.samUrl || opportunity['Other Links*'],
  }
  const now = new Date().toISOString()
  return {
    'Draft ID': deterministicDraftId(opportunityId, templateId),
    'Opportunity ID': opportunityId,
    'Template ID': templateId,
    'Template Name': clean(template['Template Name']),
    'Milestone Days': milestoneDays,
    'Due Date': dueDate,
    To: clean(recipient),
    CC: clean(cc),
    Subject: mergeFollowUpTemplate(template.Subject, context),
    Body: mergeFollowUpTemplate(template.Body, context),
    Status: recipient ? (dueDate && dueDate <= today ? 'Ready for review' : 'Scheduled') : 'Recipient needed',
    'Enrollment Date': today,
    'Enrollment Source': source,
    'Created At': now,
    'Updated At': now,
    'Updated By': clean(user),
    'Teams Notified At': '',
    'Outlook Draft ID': '',
    'Outlook Web Link': '',
    'Sent At': '',
    'Sent By': '',
    'Last Error': '',
  }
}
