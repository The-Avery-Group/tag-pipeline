import assert from 'node:assert/strict'
import test from 'node:test'
import { AuthError, verifyEntraRequest } from '../src/lib/auth.js'

const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url')
const token = (claims) => `${encode({ alg: 'RS256', kid: 'test-key' })}.${encode(claims)}.signature`
const env = { MS_TENANT_ID: 'tenant-id', MS_CLIENT_ID: 'client-id' }

test('accepts a Graph token only after Microsoft Graph validates it', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    assert.equal(url, 'https://graph.microsoft.com/v1.0/me?$select=id,displayName,userPrincipalName')
    return new Response(JSON.stringify({ id: 'user-1', displayName: 'Test User', userPrincipalName: 'test@example.com' }), { status: 200 })
  }
  try {
    const accessToken = token({
      tid: 'tenant-id', iss: 'https://sts.windows.net/tenant-id/', aud: '00000003-0000-0000-c000-000000000000',
      appid: 'client-id', scp: 'User.Read', exp: Math.floor(Date.now() / 1000) + 600, ver: '1.0',
    })
    const result = await verifyEntraRequest(new Request('https://worker.test/ai/chat', {
      headers: { Authorization: `Bearer ${accessToken}` },
    }), env)
    assert.equal(result.userId, 'user-1')
    assert.equal(result.name, 'Test User')
    assert.equal(result.email, 'test@example.com')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('rejects a token from another tenant before calling Microsoft Graph', async () => {
  const accessToken = token({
    tid: 'another-tenant', iss: 'https://sts.windows.net/another-tenant/', aud: '00000003-0000-0000-c000-000000000000',
    appid: 'client-id', scp: 'User.Read', exp: Math.floor(Date.now() / 1000) + 600, ver: '1.0',
  })
  await assert.rejects(
    verifyEntraRequest(new Request('https://worker.test/ai/chat', { headers: { Authorization: `Bearer ${accessToken}` } }), env),
    (error) => error instanceof AuthError && error.code === 'wrong_tenant',
  )
})
