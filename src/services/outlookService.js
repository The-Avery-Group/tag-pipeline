import { InteractionRequiredAuthError } from '@azure/msal-browser'
import { mailDraftRequest, msalInstance } from '@/auth/msalConfig'
import { buildOutlookDraftPayload, outlookPopoutUrl } from '@/utils/outlookDrafts'

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0'

function interactionRequired(error) {
  return error instanceof InteractionRequiredAuthError ||
    ['interaction_required', 'login_required', 'consent_required'].includes(error?.errorCode) ||
    /AADSTS65001|AADSTS65004|consent_required/i.test(String(error?.message || ''))
}

async function mailToken() {
  const account = msalInstance.getActiveAccount() || msalInstance.getAllAccounts()[0]
  if (!account) throw new Error('Your Microsoft session is unavailable. Refresh the CRM and try again.')
  try {
    const response = await msalInstance.acquireTokenSilent({ ...mailDraftRequest, account })
    return response.accessToken
  } catch (error) {
    if (!interactionRequired(error)) throw error
    try {
      const response = await msalInstance.acquireTokenPopup({ ...mailDraftRequest, account })
      return response.accessToken
    } catch (popupError) {
      const code = String(popupError?.errorCode || popupError?.message || '')
      if (/consent|65001|65004|interaction_required/i.test(code)) {
        throw new Error('Microsoft mail access is awaiting administrator consent.')
      }
      throw popupError
    }
  }
}

async function graphMailRequest(token, path, options = {}) {
  const response = await fetch(`${GRAPH_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Prefer: 'IdType="ImmutableId"',
      ...(options.headers || {}),
    },
  })
  const raw = await response.text()
  let data = null
  if (raw) {
    try { data = JSON.parse(raw) } catch { data = null }
  }
  if (response.ok) return data

  const error = new Error(data?.error?.message || `Microsoft Outlook error ${response.status}`)
  error.status = response.status
  error.code = data?.error?.code || ''
  throw error
}

function friendlyOutlookError(error, from, userEmail) {
  if (error?.status === 403 || /ErrorSendAsDenied|access is denied|does not have permission/i.test(`${error?.code} ${error?.message}`)) {
    if (String(from).toLowerCase() !== String(userEmail).toLowerCase()) {
      return new Error('Outlook could not use the selected procurement address. Ask an Exchange administrator to grant your account Send As access, or select My work email.')
    }
    return new Error('Microsoft Outlook denied access to create this draft. Confirm that Mail.ReadWrite has administrator consent.')
  }
  return error
}

export async function upsertOutlookDraft({ draft, from, userEmail }) {
  const token = await mailToken()
  const existingId = String(draft?.['Outlook Draft ID'] || '').trim()
  const common = {
    from,
    to: draft?.To,
    cc: draft?.CC,
    subject: draft?.Subject,
    body: draft?.Body,
    draftId: draft?.['Draft ID'],
  }

  try {
    if (existingId) {
      try {
        const updated = await graphMailRequest(
          token,
          `/me/messages/${encodeURIComponent(existingId)}`,
          { method: 'PATCH', body: JSON.stringify(buildOutlookDraftPayload(common)) },
        )
        return { ...updated, webLink: outlookPopoutUrl(updated?.webLink), created: false }
      } catch (error) {
        if (error?.status !== 404) throw error
      }
    }

    const created = await graphMailRequest(token, '/me/messages', {
      method: 'POST',
      body: JSON.stringify(buildOutlookDraftPayload({ ...common, includeTrackingHeader: true })),
    })
    return { ...created, webLink: outlookPopoutUrl(created?.webLink), created: true }
  } catch (error) {
    throw friendlyOutlookError(error, from, userEmail)
  }
}
