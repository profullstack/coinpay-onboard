import { describe, expect, test } from 'bun:test'
import { CoinPay, onboard, payableCoins, signWebhook, verifyWebhook, eventPaymentId } from '../src/index.js'
import { authorizeUrl, pkce } from '../src/oauth.js'
import { mergeEnv, parseArgs, parseEnv, runSite, siteKeys } from '../src/cli.js'

type Call = { method: string; path: string; body: any; auth: string | null }

/** A CoinPay that remembers what was asked of it. */
function fakeCoinPay(state: { businesses: any[]; wallets: any[]; refuse?: string[] }) {
  const calls: Call[] = []
  const fetchImpl = (async (url: string | URL, init: RequestInit = {}) => {
    const u = new URL(String(url))
    const method = init.method ?? 'GET'
    const body = init.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ method, path: u.pathname, body, auth: (init.headers as Record<string, string>)?.authorization ?? null })
    const json = (status: number, value: unknown) => new Response(JSON.stringify(value), { status })
    const key = `${method} ${u.pathname.replace(/[0-9a-f-]{36}|biz-\d+/, ':id')}`
    if (state.refuse?.includes(key)) return json(401, { success: false, error: 'Unauthorized' })
    switch (key) {
      case 'POST /api/auth/login':
        return json(200, { success: true, token: 'session-jwt' })
      case 'GET /api/businesses':
        return json(200, { success: true, businesses: state.businesses })
      case 'POST /api/businesses': {
        const b = { id: `biz-${state.businesses.length + 1}`, ...body, api_key: 'cp_live_new' }
        state.businesses.push(b)
        return json(201, { success: true, business: b })
      }
      case 'PATCH /api/businesses/:id':
        return json(200, { success: true, business: { ...state.businesses[0], ...body } })
      case 'GET /api/businesses/:id/webhook-secret':
        return json(200, { success: true, webhook_secret: 'whsec_existing' })
      case 'POST /api/businesses/:id/wallets/import':
        return json(200, { success: true, imported: state.wallets.length, skipped: 0 })
      case 'POST /api/wallets':
        state.wallets.push({ cryptocurrency: body.cryptocurrency, wallet_address: body.wallet_address })
        return json(201, { success: true })
      case 'GET /api/wallets':
        // Like CoinPay: with a business id, only that business's own wallets.
        return json(200, { success: true, wallets: u.searchParams.get('source') === 'business' ? (state as any).businessWallets ?? [] : state.wallets })
      case 'POST /api/payments/create':
        return json(201, { success: true, payment: { id: 'pay-1', status: 'pending', payment_address: 'So1addr', amount_usd: body.amount_usd, amount_crypto: '5.000000', currency: body.currency, blockchain: 'USDC_SOL', expires_at: null } })
    }
    return json(404, { success: false, error: `no route ${key}` })
  }) as typeof fetch
  return { calls, fetchImpl }
}

describe('onboard', () => {
  test('makes the business with its webhook, adds addresses, copies wallets in, and says what it can be paid in', async () => {
    const state = { businesses: [] as any[], wallets: [] as any[] }
    const { calls, fetchImpl } = fakeCoinPay(state)
    const r = await onboard(new CoinPay({ token: 't', fetch: fetchImpl }), { businessName: 'pay.agent/alice', webhookUrl: 'https://pay.agent/hooks/coinpay', addresses: { usdc_sol: ' So1abc ' } })
    expect(r.business.name).toBe('pay.agent/alice')
    expect(r.apiKey).toBe('cp_live_new')
    expect(r.webhookSecret).toMatch(/^[0-9a-f]{64}$/)
    expect(state.businesses[0].webhook_secret).toBe(r.webhookSecret)
    expect(state.wallets[0]).toEqual({ cryptocurrency: 'USDC_SOL', wallet_address: 'So1abc' })
    expect(r.coins).toEqual(['usdc_sol'])
    expect(r.steps.every((s) => s.ok)).toBe(true)
    expect(calls.every((c) => c.auth === 'Bearer t')).toBe(true)
  })

  test('run again, it finds the business and reads the secret instead of making another', async () => {
    const state = { businesses: [{ id: 'biz-1', name: 'shop', webhook_url: 'https://old/hook' }], wallets: [{ cryptocurrency: 'BTC', wallet_address: 'bc1q' }] }
    const { calls, fetchImpl } = fakeCoinPay(state)
    const r = await onboard(new CoinPay({ token: 't', fetch: fetchImpl }), { businessName: 'shop', webhookUrl: 'https://new/hook' })
    expect(calls.filter((c) => c.method === 'POST' && c.path === '/api/businesses')).toHaveLength(0)
    expect(calls.some((c) => c.method === 'PATCH' && c.body.webhook_url === 'https://new/hook')).toBe(true)
    expect(r.webhookSecret).toBe('whsec_existing')
    expect(r.coins).toEqual(['btc'])
  })

  test('a step CoinPay refuses is reported, and the others still run', async () => {
    const state = { businesses: [{ id: 'biz-1', name: 'shop' }], wallets: [], refuse: ['POST /api/businesses/:id/wallets/import', 'PATCH /api/businesses/:id'] }
    const { fetchImpl } = fakeCoinPay(state)
    const r = await onboard(new CoinPay({ token: 't', fetch: fetchImpl }), { businessName: 'shop', webhookUrl: 'https://x/hook' })
    const by = Object.fromEntries(r.steps.map((s) => [s.step, s]))
    expect(by.import!.ok).toBe(false)
    expect(by.webhook!.ok).toBe(false)
    expect(by['webhook-secret']!.ok).toBe(true)
    expect(by.coins!.detail).toMatch(/no payout addresses/)
  })

  test('a payment comes back as an address and an amount', async () => {
    const { fetchImpl } = fakeCoinPay({ businesses: [], wallets: [] })
    const p = await new CoinPay({ token: 't', fetch: fetchImpl, base: 'https://coinpayportal.com/api' }).createPayment({ businessId: 'biz-1', amountUsd: 5, currency: 'usdc_sol' })
    expect(p).toMatchObject({ id: 'pay-1', address: 'So1addr', amountCrypto: '5.000000', checkoutUrl: 'https://coinpayportal.com/pay/pay-1' })
  })
})

describe('site', () => {
  test('writes the keys into the vault, keeping what was there', async () => {
    const { fetchImpl } = fakeCoinPay({ businesses: [], wallets: [{ cryptocurrency: 'USDC_BASE', wallet_address: '0x1' }] })
    const pushed: string[] = []
    const vault = { pull: () => 'DATABASE_URL=postgres://x\nCOINPAY_API_KEY=old\n', push: (_t: string, p: string, e: string, text: string) => pushed.push(`${p}--${e}\n${text}`) }
    const lines: string[] = []
    const code = await runSite('pay.agent', { webhook: 'https://pay.agent/hooks/coinpay' }, { log: (t) => lines.push(t), error: (t) => lines.push(t) }, { client: new CoinPay({ token: 't', fetch: fetchImpl }), vault })
    expect(code).toBe(0)
    expect(pushed[0]).toStartWith('pay-agent--prod\n')
    const env = parseEnv(pushed[0]!)
    expect(env.get('DATABASE_URL')).toBe('postgres://x')
    expect(env.get('COINPAY_API_KEY')).toBe('cp_live_new')
    expect(env.get('COINPAY_API_URL')).toBe('https://coinpayportal.com/api')
    expect(env.get('COINPAY_WEBHOOK_SECRET')).toMatch(/^[0-9a-f]{64}$/)
  })

  test('refuses without a webhook', async () => {
    const lines: string[] = []
    expect(await runSite('x', {}, { log: (t) => lines.push(t), error: (t) => lines.push(t) }, { client: new CoinPay(), vault: { pull: () => '', push: () => {} } })).toBe(2)
  })

  test('--no-vault prints instead of writing', async () => {
    const { fetchImpl } = fakeCoinPay({ businesses: [], wallets: [] })
    let pushed = false
    const lines: string[] = []
    await runSite('a.b', { webhook: 'https://a.b/h', ...parseArgs(['--no-vault']).flags }, { log: (t) => lines.push(t), error: (t) => lines.push(t) }, { client: new CoinPay({ token: 't', fetch: fetchImpl }), vault: { pull: () => '', push: () => { pushed = true } } })
    expect(pushed).toBe(false)
    expect(lines.some((l) => l.startsWith('COINPAY_BUSINESS_ID='))).toBe(true)
  })
})

describe('pieces', () => {
  test('webhook signatures round-trip, and stale or forged ones fail', () => {
    const body = JSON.stringify({ id: 'evt_1', type: 'payment.confirmed', data: { payment_id: 'p1', status: 'confirmed' } })
    const header = signWebhook(body, 's3cret')
    expect(verifyWebhook(body, header, 's3cret')).toBe(true)
    expect(verifyWebhook(body + ' ', header, 's3cret')).toBe(false)
    expect(verifyWebhook(body, header, 'other')).toBe(false)
    expect(verifyWebhook(body, header, 's3cret', Date.now() + 10 * 60_000)).toBe(false)
    expect(verifyWebhook(body, null, 's3cret')).toBe(false)
    expect(eventPaymentId(JSON.parse(body))).toBe('p1')
  })

  test('mergeEnv replaces in place and appends the rest', () => {
    expect(mergeEnv('A=1\n# c\nB=2\n', { B: '3', C: '4' })).toBe('A=1\n# c\nB=3\nC=4\n')
    expect(mergeEnv('', { A: '1' })).toBe('\nA=1\n'.trimStart())
  })

  test('siteKeys leaves out what onboarding could not get', () => {
    expect(siteKeys({ business: { id: 'b', name: 'n' }, apiKey: null, webhookSecret: null, coins: [], steps: [] }, 'https://c')).toEqual({ COINPAY_API_URL: 'https://c/api', COINPAY_BUSINESS_ID: 'b' })
  })

  test('PKCE and the authorize URL ask for S256 and the onboarding scopes', () => {
    const { verifier, challenge } = pkce()
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/)
    const url = new URL(authorizeUrl({ clientId: 'cp_x', redirectUri: 'https://pay.agent/auth/callback', state: 's', challenge }))
    expect(url.pathname).toBe('/api/oauth/authorize')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('scope')).toBe('openid profile email wallet:read merchant')
  })

  test('payableCoins maps wallet codes to coin ids', () => {
    expect(payableCoins(['USDC_SOL', 'BTC', 'NOPE'])).toEqual(['usdc_sol', 'btc'])
  })
})
