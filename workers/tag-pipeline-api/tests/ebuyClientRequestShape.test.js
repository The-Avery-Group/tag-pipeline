import test from 'node:test'
import assert from 'node:assert/strict'
import { authenticateEbuyAccount } from '../src/lib/ebuyClient.js'

function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  })
}

test('live eBuy authentication preserves the first-party request context from the mapped client', async () => {
  const originalFetch = globalThis.fetch
  const calls = []
  const responses = [
    jsonResponse({
      status: 'MFA_REQUIRED', stateToken: 'state-token',
      _embedded: { factors: [{ id: 'factor-1', factorType: 'token:software:totp' }] },
    }),
    jsonResponse({ status: 'SUCCESS', sessionToken: 'session-token' }),
    jsonResponse({ response: { pkce_code_verifier: 'verifier', pkce_code_challenger: 'challenge', pkce_state: 'pkce-state' } }),
    new Response(null, {
      status: 302,
      headers: { Location: 'https://www.ebuy.gsa.gov/ebuy/pkce/callback?code=authorization-code&state=pkce-state' },
    }),
    jsonResponse({ access_token: 'access-token', expires_in: 3600 }),
    jsonResponse({
      header: { status: 0 },
      response: {
        sellerEmails: ['47QRAA22D0000'],
        sellerContractInfoList: [{ contractNumber: '47QRAA22D0000', contractVehicle: 'MAS', companyName: 'TAG' }],
      },
    }),
  ]

  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options })
    const response = responses.shift()
    assert.ok(response, `Unexpected request to ${url}`)
    return response
  }

  try {
    const result = await authenticateEbuyAccount({
      username: 'authorized@example.com',
      password: 'not-stored-by-test',
      totpSecret: 'JBSWY3DPEHPK3PXP',
    })
    assert.equal(result.contracts[0].contractNumber, '47QRAA22D0000')

    const pkce = calls.find((call) => call.url.includes('/seller/login/pkce'))
    assert.equal(pkce.options.headers.Referer, 'https://www.ebuy.gsa.gov/ebuy/')

    const token = calls.find((call) => call.url.includes('/v1/token'))
    assert.equal(token.options.headers.Origin, 'https://www.ebuy.gsa.gov')
    assert.equal(token.options.headers.Referer, 'https://www.ebuy.gsa.gov/ebuy/')

    const sellerLogin = calls.find((call) => call.url.includes('/seller/oktalogin/'))
    assert.equal(sellerLogin.options.headers['Content-Type'], 'text/plain')
    assert.equal(sellerLogin.options.headers.Origin, 'https://www.ebuy.gsa.gov')
    assert.equal(sellerLogin.options.headers.Referer, 'https://www.ebuy.gsa.gov/ebuy/pkce/callback')
  } finally {
    globalThis.fetch = originalFetch
  }
})
