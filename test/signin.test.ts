import { describe, expect, test } from 'bun:test'
import { authorizeUrl, checkIdToken, finishSignIn, pkce, randomToken, sameState, SIGN_IN_SCOPES } from '../src/oauth.js'

const jwt = (claims: Record<string, unknown>) =>
  ['{"alg":"HS256","typ":"JWT"}', JSON.stringify(claims), 'sig'].map((part, i) => (i < 2 ? Buffer.from(part).toString('base64url') : part)).join('.')
const NOW = 1_800_000_000_000
const good = { iss: 'https://coinpayportal.com', sub: 'u_1', aud: 'cp_app', exp: NOW / 1000 + 600, nonce: 'n0nce' }

describe('sign in with CoinPay', () => {
  test('authorize URL carries the nonce, S256 and the sign-in scopes', () => {
    const { challenge } = pkce()
    const url = new URL(authorizeUrl({ clientId: 'cp_app', redirectUri: 'https://a.example/api/v1/coinpay/oauth/callback', state: 's', nonce: 'n', challenge, scopes: SIGN_IN_SCOPES }))
    expect(url.searchParams.get('nonce')).toBe('n')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('scope')).toBe('openid profile email')
    expect(randomToken()).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })

  test('checkIdToken accepts the right token and rejects a wrong nonce, audience, issuer or expiry', () => {
    expect(checkIdToken({ idToken: jwt(good), clientId: 'cp_app', nonce: 'n0nce', now: NOW }).sub).toBe('u_1')
    expect(checkIdToken({ idToken: jwt({ ...good, iss: 'https://coinpayportal.com/' }), clientId: 'cp_app', nonce: 'n0nce', now: NOW }).sub).toBe('u_1')
    expect(() => checkIdToken({ idToken: jwt(good), clientId: 'cp_app', nonce: 'other', now: NOW })).toThrow(/nonce/)
    expect(() => checkIdToken({ idToken: jwt({ ...good, nonce: undefined }), clientId: 'cp_app', nonce: 'n0nce', now: NOW })).toThrow(/nonce/)
    expect(() => checkIdToken({ idToken: jwt(good), clientId: 'cp_other', nonce: 'n0nce', now: NOW })).toThrow(/audience/)
    expect(() => checkIdToken({ idToken: jwt({ ...good, iss: 'https://evil.example' }), clientId: 'cp_app', nonce: 'n0nce', now: NOW })).toThrow(/issuer/)
    expect(() => checkIdToken({ idToken: jwt({ ...good, exp: NOW / 1000 - 3600 }), clientId: 'cp_app', nonce: 'n0nce', now: NOW })).toThrow(/expired/)
    expect(() => checkIdToken({ idToken: null, clientId: 'cp_app', nonce: 'n0nce', now: NOW })).toThrow(/no id_token/)
  })

  test('sameState is constant-time equality that refuses empty values', () => {
    expect(sameState('abc', 'abc')).toBe(true)
    expect(sameState('abc', 'abd')).toBe(false)
    expect(sameState('', '')).toBe(false)
    expect(sameState('abc', null)).toBe(false)
  })

  test('finishSignIn exchanges the code with the secret, checks the nonce and matches userinfo', async () => {
    const seen: { url: string; body?: string; auth?: string | null }[] = []
    const fake = (async (url: URL, init?: RequestInit) => {
      seen.push({ url: String(url), body: init?.body as string, auth: new Headers(init?.headers).get('authorization') })
      if (String(url).endsWith('/token')) return Response.json({ access_token: 'at', expires_in: 3600, scope: 'openid profile email', id_token: jwt(good) })
      return Response.json({ sub: 'u_1', email: 'someone@example.com', email_verified: false, name: 'Some One' })
    }) as unknown as typeof fetch
    const result = await finishSignIn({ code: 'c', verifier: 'v', nonce: 'n0nce', clientId: 'cp_app', clientSecret: 'shh', redirectUri: 'https://a.example/cb', fetch: fake, now: NOW })
    expect(result).toMatchObject({ sub: 'u_1', email: 'someone@example.com', name: 'Some One' })
    const form = new URLSearchParams(seen[0]!.body)
    expect(form.get('client_secret')).toBe('shh')
    expect(form.get('code_verifier')).toBe('v')
    expect(seen[1]!.auth).toBe('Bearer at')
    await expect(finishSignIn({ code: 'c', verifier: 'v', nonce: 'wrong', clientId: 'cp_app', clientSecret: 'shh', redirectUri: 'https://a.example/cb', fetch: fake, now: NOW })).rejects.toThrow(/nonce/)
  })

  test('finishSignIn refuses a userinfo sub that differs from the id_token', async () => {
    const fake = (async (url: URL) =>
      String(url).endsWith('/token') ? Response.json({ access_token: 'at', id_token: jwt(good) }) : Response.json({ sub: 'u_2' })) as unknown as typeof fetch
    await expect(finishSignIn({ code: 'c', verifier: 'v', nonce: 'n0nce', clientId: 'cp_app', clientSecret: 's', redirectUri: 'https://a.example/cb', fetch: fake, now: NOW })).rejects.toThrow(/sub/)
  })
})
