const clean = (value) => String(value ?? '').trim()

export function formatRecipientNames(names = []) {
  const unique = [...new Set(names.map(clean).filter(Boolean))]
  if (unique.length < 2) return unique[0] || ''
  if (unique.length === 2) return `${unique[0]} and ${unique[1]}`
  return `${unique.slice(0, -1).join(', ')}, and ${unique.at(-1)}`
}

export function normalizedDate(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const date = new Date((value - 25569) * 86400000)
    return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 10)
  }
  const match = clean(value).match(/^(\d{4})-(\d{2})-(\d{2})/)
  return match ? `${match[1]}-${match[2]}-${match[3]}` : ''
}

export function addDays(value, days) {
  const date = new Date(`${normalizedDate(value)}T00:00:00Z`)
  if (Number.isNaN(date.getTime())) return ''
  date.setUTCDate(date.getUTCDate() + Number(days || 0))
  return date.toISOString().slice(0, 10)
}

export function deterministicDraftId(opportunityId, templateId) {
  return `FU-${clean(opportunityId).toLowerCase()}-${clean(templateId).toLowerCase()}`
    .replace(/[^a-z0-9:_-]+/g, '-')
    .slice(0, 180)
}

export function mergeTemplate(value, context = {}) {
  const contactNames = clean(context.contactFirstName)
  const replacements = {
    contact_first_name: contactNames,
    contact_first_names: contactNames,
    opportunity_title: clean(context.opportunityTitle),
    notice_id: clean(context.noticeId),
    agency: clean(context.agency),
    submission_date: normalizedDate(context.submissionDate),
    days_since_submission: clean(context.daysSinceSubmission),
    sam_url: clean(context.samUrl),
  }
  const unwrapped = clean(value).replace(
    /<span\b[^>]*data-email-merge-field=["']true["'][^>]*>([\s\S]*?)<\/span>/gi,
    '$1',
  )
  return unwrapped.replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (match, key) =>
    Object.hasOwn(replacements, key.toLowerCase()) ? replacements[key.toLowerCase()] : match
  )
}

export function buildScheduledDraft({ opportunity, template, recipient = '', recipients, today, now }) {
  const opportunityId = clean(opportunity['Contract Number / Notice ID'])
  const templateId = clean(template['Template ID'])
  const milestoneDays = Number(template['Days After Submission'] || 0)
  const submissionDate = normalizedDate(opportunity['Submission Date (Response Date)*'])
  const dueDate = addDays(submissionDate, milestoneDays)
  const samUrl = clean(opportunity['Other Links*']).split(/\s+/).find((value) => /sam\.gov/i.test(value)) || ''
  const recipientList = Array.isArray(recipients) ? recipients : [recipient]
  const validRecipients = recipientList.filter((item) => clean(item?.email))
  const contactFirstNames = validRecipients.map((item) => clean(item.name).split(/\s+/)[0] || '')
  const recipientEmails = [...new Set(validRecipients.map((item) => clean(item.email)).filter(Boolean))]
  const context = {
    contactFirstName: formatRecipientNames(contactFirstNames),
    opportunityTitle: opportunity['Project Title / Description*'],
    noticeId: opportunityId,
    agency: opportunity['Agency*'],
    submissionDate,
    daysSinceSubmission: milestoneDays,
    samUrl,
  }
  return {
    'Draft ID': deterministicDraftId(opportunityId, templateId),
    'Opportunity ID': opportunityId,
    'Template ID': templateId,
    'Template Name': clean(template['Template Name']),
    'Milestone Days': milestoneDays,
    'Due Date': dueDate,
    To: recipientEmails.join('; '),
    CC: '',
    Subject: mergeTemplate(template.Subject, context),
    Body: mergeTemplate(template.Body, context),
    Status: recipientEmails.length ? (dueDate && dueDate <= today ? 'Ready for review' : 'Scheduled') : 'Recipient needed',
    'Enrollment Date': today,
    'Enrollment Source': 'Automatic',
    'Created At': now,
    'Updated At': now,
    'Updated By': 'Scheduled Worker',
    'Teams Notified At': '',
    'Outlook Draft ID': '',
    'Outlook Web Link': '',
    'Sent At': '',
    'Sent By': '',
    'Last Error': '',
  }
}
