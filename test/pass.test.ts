import { describe, expect, test } from 'bun:test'
import { hasPassAccess, PASS_URL, passFromUserinfo } from '../src/index.js'
import { finishSignIn } from '../src/oauth.js'

const NOW = new Date('2026-11-07T12:00:00.000Z')
const FUTURE = '2026-12-07T18:00:00.000Z'
const PAST = '2026-11-01T00:00:00.000Z'

describe('Profullstack Pass', () => {
  test('an active pass with a future expiry is active', () => {
    expect(passFromUserinfo({ sub: 'u_1', pass: { active: true, expires_at: FUTURE } }, NOW)).toEqual({ active: true, expiresAt: new Date(FUTURE) })
    expect(hasPassAccess({ pass: { active: true, expires_at: FUTURE } }, NOW)).toBe(true)
  })

  test('an expired pass is inactive but keeps its expiry', () => {
    expect(passFromUserinfo({ pass: { active: false, expires_at: PAST } }, NOW)).toEqual({ active: false, expiresAt: new Date(PAST) })
    expect(passFromUserinfo({ pass: { active: false } }, NOW)).toEqual({ active: false, expiresAt: null })
  })

  test('active:true is not trusted with a past, missing or unparseable expiry', () => {
    expect(passFromUserinfo({ pass: { active: true, expires_at: PAST } }, NOW)).toEqual({ active: false, expiresAt: new Date(PAST) })
    expect(passFromUserinfo({ pass: { active: true } }, NOW)).toEqual({ active: false, expiresAt: null })
    expect(passFromUserinfo({ pass: { active: true, expires_at: 'soon' } }, NOW)).toEqual({ active: false, expiresAt: null })
    expect(passFromUserinfo({ pass: { active: true, expires_at: NOW.toISOString() } }, NOW).active).toBe(false)
    expect(hasPassAccess({ pass: { active: 'true', expires_at: FUTURE } }, NOW)).toBe(false)
  })

  test('a missing claim is no pass', () => {
    expect(passFromUserinfo({ sub: 'u_1', email: 'a@example.com' }, NOW)).toEqual({ active: false, expiresAt: null })
    expect(passFromUserinfo({ pass: null }, NOW)).toEqual({ active: false, expiresAt: null })
    expect(hasPassAccess({ sub: 'u_1' }, NOW)).toBe(false)
  })

  test('non-object input is no pass', () => {
    for (const input of [undefined, null, 0, 'pass', true, [], { pass: 'yes' }, { pass: 1 }]) {
      expect(passFromUserinfo(input, NOW)).toEqual({ active: false, expiresAt: null })
      expect(hasPassAccess(input, NOW)).toBe(false)
    }
  })

  test('PASS_URL is the CoinPay pass page', () => {
    expect(PASS_URL).toBe('https://coinpayportal.com/pass')
  })

  test('finishSignIn surfaces the pass from userinfo', async () => {
    const now = NOW.getTime()
    const idToken = ['{"alg":"HS256","typ":"JWT"}', JSON.stringify({ iss: 'https://coinpayportal.com', sub: 'u_1', aud: 'cp_app', exp: now / 1000 + 600, nonce: 'n' }), 'sig']
      .map((part, i) => (i < 2 ? Buffer.from(part).toString('base64url') : part))
      .join('.')
    const fake = (async (url: URL) =>
      String(url).endsWith('/token')
        ? Response.json({ access_token: 'at', id_token: idToken })
        : Response.json({ sub: 'u_1', pass: { active: true, expires_at: FUTURE } })) as unknown as typeof fetch
    const result = await finishSignIn({ code: 'c', verifier: 'v', nonce: 'n', clientId: 'cp_app', clientSecret: 's', redirectUri: 'https://a.example/cb', fetch: fake, now })
    expect(result.pass).toEqual({ active: true, expiresAt: new Date(FUTURE) })
  })
})
