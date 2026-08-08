const clean = (value) => String(value ?? '').trim()

export function parseEmailAddresses(value) {
  const seen = new Set()
  return String(value || '')
    .split(/[;,]/)
    .map(clean)
    .filter((address) => {
      const key = address.toLowerCase()
      if (!address || seen.has(key)) return false
      seen.add(key)
      return true
    })
}

export function isEmailAddress(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean(value))
}

function graphRecipient(address) {
  return { emailAddress: { address } }
}

export function buildOutlookDraftPayload({ from, to, cc, subject, body, draftId, includeTrackingHeader = false }) {
  const fromAddress = clean(from)
  const toAddresses = parseEmailAddresses(to)
  const ccAddresses = parseEmailAddresses(cc)

  if (!isEmailAddress(fromAddress)) throw new Error('Select a valid From email address.')
  if (!toAddresses.length || toAddresses.some((address) => !isEmailAddress(address))) {
    throw new Error('Add at least one valid recipient email address.')
  }
  if (ccAddresses.some((address) => !isEmailAddress(address))) {
    throw new Error('One or more CC email addresses are invalid.')
  }
  if (!clean(subject)) throw new Error('Add an email subject before opening Outlook.')
  if (!clean(body)) throw new Error('Add an email body before opening Outlook.')

  return {
    subject: clean(subject),
    body: { contentType: 'HTML', content: body },
    from: graphRecipient(fromAddress),
    toRecipients: toAddresses.map(graphRecipient),
    ccRecipients: ccAddresses.map(graphRecipient),
    ...(includeTrackingHeader && clean(draftId) ? {
      internetMessageHeaders: [{
        name: 'x-tag-crm-draft-id',
        value: clean(draftId).replace(/[\r\n]/g, '').slice(0, 180),
      }],
    } : {}),
  }
}

export function outlookPopoutUrl(webLink) {
  const value = clean(webLink)
  if (!value) return ''
  try {
    const url = new URL(value)
    url.searchParams.set('ispopout', '1')
    return url.toString()
  } catch {
    return value
  }
}

export function outlookLaunchPlan(webLink) {
  return {
    appUrl: 'ms-outlook://',
    webUrl: outlookPopoutUrl(webLink),
    fallbackDelayMs: 4000,
  }
}
