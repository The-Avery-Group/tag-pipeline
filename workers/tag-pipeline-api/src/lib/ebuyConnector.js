/**
 * Boundary for the future live GSA eBuy connector.
 *
 * Authentication endpoints and response contracts must be observed from an
 * authorized TAG eBuy session before this is enabled. Keeping that uncertainty
 * behind one interface lets the fixture archive, UI, D1 schema, SharePoint
 * storage, retention, and Workflow orchestration ship without guessing at or
 * weakening the eventual login flow.
 */
export function getEbuyConnectorStatus(env) {
  const enabled = String(env.EBUY_LIVE_CONNECTOR_ENABLED || '').toLowerCase() === 'true'
  return {
    enabled,
    mode: enabled ? 'manual_ready' : 'fixture',
    message: enabled
      ? 'Manual eBuy sign-in is enabled.'
      : 'The archive is running with sanitized test data. Manual eBuy sign-in will be enabled after the authorized login flow is mapped.',
    automationReady: Boolean(env.EBUY_USERNAME && env.EBUY_PASSWORD && env.EBUY_TOTP_SECRET),
  }
}

export async function fetchEbuyWithManualSession(_env, credentials) {
  // Do not log, persist, or forward raw credentials until the authorized FAS
  // authentication contract has been mapped and tested. The caller clears its
  // request-local reference immediately after this function returns.
  if (!credentials?.username || !credentials?.password || !credentials?.otp) {
    const error = new Error('Username, password, and the current six-digit code are required')
    error.code = 'missing_credentials'
    throw error
  }
  const error = new Error('Manual eBuy sign-in is not enabled yet. Use the sanitized test sync while the authorized login flow is being mapped.')
  error.code = 'live_connector_not_configured'
  throw error
}

