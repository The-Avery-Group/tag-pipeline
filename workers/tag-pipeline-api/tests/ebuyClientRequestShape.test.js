import test from 'node:test'
import assert from 'node:assert/strict'
import { authenticateEbuyAccount, downloadEbuyAttachment } from '../src/lib/ebuyClient.js'

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
      // The seller-login endpoint can return a nonstandard envelope status
      // even when its contract-list payload is successful.
      header: { status: 1 },
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

test('live eBuy attachment download sends the source attachment DTO expected by eBuy', async () => {
  const originalFetch = globalThis.fetch
  let captured
  globalThis.fetch = async (url, options = {}) => {
    captured = { url: String(url), options }
    return new Response('pdf-content', {
      status: 200,
      headers: { 'Content-Type': 'application/pdf', 'Content-Length': '11' },
    })
  }

  try {
    const response = await downloadEbuyAttachment('RFQ1829030', {
      fileName: 'Statement of Work.pdf',
      docPath: '/documents/statement-of-work.pdf',
      docSeqNum: 4,
      docType: 1,
      docSessionId: 12345,
      docSessionDate: 1_786_000_000_000,
      seqNum: 4,
    }, 'contract-jwt')

    assert.equal(response.status, 200)
    assert.equal(captured.url, 'https://www.ebuy.gsa.gov/ebuy/api/services/ebuyservices/rfq/RFQ1829030/rfqAttachment/')
    assert.equal(captured.options.method, 'POST')
    assert.equal(captured.options.headers.Accept, 'application/json, text/plain, */*')
    assert.equal(captured.options.headers.Authorization, undefined)
    assert.equal(captured.options.headers.Origin, 'https://www.ebuy.gsa.gov/')
    assert.equal(captured.options.headers.Referer, 'https://www.ebuy.gsa.gov/ebuy/seller/prepare-quote/RFQ1829030')
    assert.deepEqual(JSON.parse(captured.options.body.get('data')), {
      docName: 'Statement of Work.pdf',
      docPath: '/documents/statement-of-work.pdf',
      docSeqNum: 4,
      docType: 1,
      docSessionId: 12345,
      docSessionDate: 1_786_000_000_000,
      seqNum: 4,
    })
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('live eBuy attachment download retries a protected upload path when the attachment endpoint returns JSON', async () => {
  const originalFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options })
    if (calls.length === 1) return jsonResponse({ response: null })
    return new Response('docx-content', {
      status: 200,
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'Content-Length': '12',
      },
    })
  }

  try {
    const response = await downloadEbuyAttachment('RFI1830128', {
      fileName: '003 - Statement of Work.docx',
      docPath: '/ebuy_upload/202608/RFI1830128/folder/003 - Statement of Work.123.docx',
      docSeqNum: 3788332,
      docType: 0,
      docSessionId: 0,
      docSessionDate: 1_786_625_569_637,
      seqNum: 3788332,
    }, 'contract-jwt')

    assert.equal(response.status, 200)
    assert.equal(calls.length, 2)
    assert.equal(calls[1].url, 'https://www.ebuy.gsa.gov/ebuy_upload/202608/RFI1830128/folder/003%20-%20Statement%20of%20Work.123.docx')
    assert.equal(calls[1].options.headers.Authorization, undefined)
    assert.equal(calls[1].options.headers.Origin, 'https://www.ebuy.gsa.gov/')
  } finally {
    globalThis.fetch = originalFetch
  }
})
