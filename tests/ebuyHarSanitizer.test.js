import assert from 'node:assert/strict'
import test from 'node:test'

await import('../tools/ebuy-mapping/sanitizer.js')

const sanitizer = globalThis.EbuyHarSanitizer

function sampleHar() {
  return {
    log: {
      entries: [
        {
          startedDateTime: '2026-08-11T12:00:00.000Z',
          time: 125.4,
          _resourceType: 'fetch',
          request: {
            method: 'POST',
            url: 'https://www.ebuy.gsa.gov/api/opportunities?page=2&session=super-secret',
            httpVersion: 'HTTP/2',
            headers: [
              { name: 'Authorization', value: 'Bearer eyJhbGciOiJIUzI1NiJ9.secret.signature' },
              { name: 'Content-Type', value: 'application/json' },
              { name: 'X-Custom-Session', value: 'another-secret' },
            ],
            cookies: [{ name: 'session', value: 'cookie-secret' }],
            postData: {
              mimeType: 'application/json',
              text: JSON.stringify({ username: 'person@example.com', password: 'never-export-me', page: 2 }),
            },
          },
          response: {
            status: 200,
            statusText: 'OK',
            httpVersion: 'HTTP/2',
            headers: [
              { name: 'Set-Cookie', value: 'session=server-secret' },
              { name: 'Content-Type', value: 'application/json' },
            ],
            cookies: [{ name: 'session', value: 'server-secret' }],
            content: {
              mimeType: 'application/json',
              size: 200,
              text: JSON.stringify({ results: [{ requestId: 'RFI123', buyerEmail: 'buyer@gsa.gov', closesAt: '2026-08-20T17:00:00Z' }] }),
            },
          },
          timings: { blocked: 1, connect: 10, send: 2, wait: 90, receive: 22 },
        },
        {
          _resourceType: 'script',
          request: { method: 'GET', url: 'https://www.ebuy.gsa.gov/assets/app.js', headers: [] },
          response: { status: 200, headers: [], content: { mimeType: 'application/javascript', text: 'secret source' } },
          timings: {},
        },
      ],
    },
  }
}

test('sanitizes eBuy HAR values while preserving the connector structure', () => {
  const capture = sanitizer.sanitizeCapture(sampleHar(), { kind: 'activity' })
  assert.equal(capture.summary.totalRequests, 2)
  assert.equal(capture.summary.retainedRequests, 1)
  assert.equal(capture.summary.excludedRequests, 1)

  const [entry] = capture.entries
  assert.equal(entry.endpoint.path, '/api/opportunities')
  assert.deepEqual(entry.endpoint.queryParameters.map((item) => item.name), ['page', 'session'])
  assert.ok(entry.endpoint.queryParameters.every((item) => item.value === '[REDACTED]'))
  assert.equal(entry.request.headers.find((item) => item.name === 'Authorization').value, '[REDACTED]')
  assert.equal(entry.request.headers.find((item) => item.name === 'X-Custom-Session').value, '[REDACTED]')
  assert.equal(entry.request.cookieCountRemoved, 1)
  assert.equal(entry.response.cookieCountRemoved, 1)
  assert.equal(entry.request.body.shape.fields.username.type, 'string')
  assert.equal(entry.response.body.shape.fields.results.item.fields.buyerEmail.format, 'email')

  const serialized = JSON.stringify(capture)
  for (const secret of ['super-secret', 'never-export-me', 'person@example.com', 'buyer@gsa.gov', 'cookie-secret', 'server-secret']) {
    assert.equal(serialized.includes(secret), false, `${secret} should not survive sanitization`)
  }
})

test('removes authentication response bodies and produces a safe package', () => {
  const capture = sanitizer.sanitizeCapture(sampleHar(), { kind: 'authentication' })
  assert.equal(capture.entries[0].response.body.bodyRemoved, true)
  assert.match(capture.entries[0].response.body.reason, /Authentication response bodies/)

  const output = sanitizer.buildPackage([capture])
  assert.equal(output.safety.safe, true)
  assert.equal(output.privacy.originalHarIncluded, false)
  assert.equal(output.completeness.authenticationCapture, true)
  assert.equal(output.completeness.activityCapture, false)
})

test('rejects input that is not a HAR export', () => {
  assert.throws(() => sanitizer.parseHar({}), /not a valid HAR/)
})
