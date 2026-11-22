import { describe, expect, test } from 'bun:test'
import { CoinPay, defaultUserAgent } from '../src/index.js'
import { VERSION } from '../src/version.js'

describe('user-agent', () => {
  test('names the app, its site and this package', () => {
    const saved = { ...process.env }
    try {
      delete process.env.COINPAY_USER_AGENT
      process.env.COINPAY_APP_NAME = 'example'
      process.env.npm_package_version = '2.0.0'
      process.env.APP_URL = 'https://example.test/'
      expect(defaultUserAgent()).toBe(`example/2.0.0 (+https://example.test) coinpay-onboard/${VERSION}`)
      process.env.COINPAY_USER_AGENT = 'custom/1'
      expect(defaultUserAgent()).toBe('custom/1')
    } finally {
      process.env = saved
    }
  })

  test('every call carries it unless the caller set one', async () => {
    const seen: Record<string, string>[] = []
    const fetch = (async (_url: string, init: RequestInit) => {
      seen.push(init.headers as Record<string, string>)
      return new Response('{"businesses":[]}')
    }) as unknown as typeof globalThis.fetch
    const cp = new CoinPay({ token: 'cp_live_x', fetch, userAgent: 'site/1 (+https://site.test)' })
    await cp.businesses()
    await cp.call('GET', '/api/businesses', undefined, { 'User-Agent': 'mine' })
    expect(seen[0]!['user-agent']).toBe('site/1 (+https://site.test)')
    expect(seen[0]!.authorization).toBe('Bearer cp_live_x')
    expect(seen[1]!['User-Agent']).toBe('mine')
    expect(seen[1]!['user-agent']).toBeUndefined()
  })
})
