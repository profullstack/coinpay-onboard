/**
 * @profullstack/coinpay-onboard: get somebody (or a site) ready to take crypto
 * on CoinPay in one pass, and take it.
 *
 * One engine, two front doors:
 *  - a person signs in with CoinPay (OAuth, scope `merchant wallet:read`) and an
 *    app like pay.agent calls onboard() with their token;
 *  - a fleet site at launch: `coinpay-onboard site <name>` logs in as the
 *    merchant and writes the site's keys into its vault.
 *
 * Every step is idempotent: run it again and it finds what it made last time.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

export const DEFAULT_BASE = 'https://coinpayportal.com'

/** What CoinPay takes payment in (POST /api/payments/create `currency`). */
export const COINS = [
  { id: 'usdc_sol', name: 'USDC on Solana', chain: 'SOL', stable: true },
  { id: 'usdc_base', name: 'USDC on Base', chain: 'BASE', stable: true },
  { id: 'usdc_pol', name: 'USDC on Polygon', chain: 'POL', stable: true },
  { id: 'usdc_eth', name: 'USDC on Ethereum', chain: 'ETH', stable: true },
  { id: 'usdt_sol', name: 'USDT on Solana', chain: 'SOL', stable: true },
  { id: 'usdt_pol', name: 'USDT on Polygon', chain: 'POL', stable: true },
  { id: 'usdt_eth', name: 'USDT on Ethereum', chain: 'ETH', stable: true },
  { id: 'btc', name: 'Bitcoin', chain: 'BTC', stable: false },
  { id: 'eth', name: 'Ether', chain: 'ETH', stable: false },
  { id: 'sol', name: 'Solana', chain: 'SOL', stable: false },
  { id: 'pol', name: 'Polygon', chain: 'POL', stable: false },
  { id: 'bch', name: 'Bitcoin Cash', chain: 'BCH', stable: false },
  { id: 'doge', name: 'Dogecoin', chain: 'DOGE', stable: false },
  { id: 'xrp', name: 'XRP', chain: 'XRP', stable: false },
  { id: 'ada', name: 'Cardano', chain: 'ADA', stable: false },
  { id: 'bnb', name: 'BNB', chain: 'BNB', stable: false },
] as const

export type CoinId = (typeof COINS)[number]['id']

/** The wallet a coin settles to: CoinPay keys payout wallets by cryptocurrency code. */
export function walletCode(coin: string): string {
  return coin.toUpperCase()
}

export class CoinPayError extends Error {
  constructor(message: string, readonly status: number, readonly body?: unknown) {
    super(message)
    this.name = 'CoinPayError'
  }
}

export type Business = { id: string; name: string; merchant_id?: string; webhook_url?: string | null; api_key?: string; [k: string]: unknown }
export type Wallet = { address: string; chain?: string; cryptocurrency?: string; wallet_address?: string; label?: string | null; business_id?: string | null; source?: string }

export type Payment = {
  id: string
  status: string
  address: string
  amountUsd: number
  amountCrypto: string
  currency: string
  blockchain: string
  expiresAt: string | null
  checkoutUrl: string
}

export type CoinPayOptions = {
  /** An OAuth access token (scope `merchant`), a dashboard session JWT, or a business API key. */
  token?: string
  base?: string
  fetch?: typeof fetch
}

/** A thin CoinPay API client: the calls onboarding and taking payment need, nothing else. */
export class CoinPay {
  readonly base: string
  private readonly token: string | undefined
  private readonly doFetch: typeof fetch

  constructor(options: CoinPayOptions = {}) {
    this.base = (options.base ?? DEFAULT_BASE).replace(/\/+$/, '').replace(/\/api$/, '')
    this.token = options.token
    this.doFetch = options.fetch ?? fetch
  }

  /** Signs in as a merchant with email and password; returns a client holding the session. */
  static async login(email: string, password: string, options: Omit<CoinPayOptions, 'token'> = {}): Promise<CoinPay> {
    const anonymous = new CoinPay(options)
    const body = await anonymous.call<{ token?: string }>('POST', '/api/auth/login', { email, password })
    if (!body.token) throw new CoinPayError('CoinPay login returned no token', 500, body)
    return new CoinPay({ ...options, token: body.token })
  }

  async call<T = any>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
    const response = await this.doFetch(this.base + path, {
      method,
      headers: {
        accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
    })
    const text = await response.text()
    let parsed: any = null
    try {
      parsed = text ? JSON.parse(text) : null
    } catch {
      // An HTML page where JSON was expected: almost always a base URL ending in /api twice, or none.
      throw new CoinPayError(`CoinPay answered ${response.status} with something that is not JSON (${path})`, response.status, text.slice(0, 200))
    }
    if (!response.ok || parsed?.success === false) {
      throw new CoinPayError(parsed?.error ?? parsed?.message ?? `CoinPay answered ${response.status} (${path})`, response.status, parsed)
    }
    return parsed as T
  }

  /** Who the token belongs to (OAuth userinfo): sub, name, email, and wallets with `wallet:read`. */
  userinfo(): Promise<{ sub: string; name?: string; email?: string; wallets?: Wallet[] }> {
    return this.call('GET', '/api/oauth/userinfo')
  }

  async businesses(): Promise<Business[]> {
    const body = await this.call<{ businesses?: Business[] }>('GET', '/api/businesses')
    return body.businesses ?? []
  }

  async createBusiness(input: { name: string; category: string; description?: string; webhook_url?: string; webhook_secret?: string; webhook_events?: string[] }): Promise<Business> {
    const body = await this.call<{ business: Business }>('POST', '/api/businesses', input)
    return body.business
  }

  async updateBusiness(id: string, input: Record<string, unknown>): Promise<Business> {
    const body = await this.call<{ business?: Business }>('PATCH', `/api/businesses/${encodeURIComponent(id)}`, input)
    return body.business ?? ({ id, ...input } as Business)
  }

  async webhookSecret(businessId: string): Promise<string> {
    const body = await this.call<{ webhook_secret?: string; secret?: string }>('GET', `/api/businesses/${encodeURIComponent(businessId)}/webhook-secret`)
    const secret = body.webhook_secret ?? body.secret
    if (!secret) throw new CoinPayError('CoinPay returned no webhook secret', 500, body)
    return secret
  }

  /** The account's payout wallets (and linked web wallets, where CoinPay reports them). */
  async wallets(source: 'account' | 'business' | 'all' = 'all', businessId?: string): Promise<Wallet[]> {
    const q = new URLSearchParams({ source, ...(businessId ? { business_id: businessId } : {}) })
    const body = await this.call<{ wallets?: Wallet[] }>('GET', `/api/wallets?${q}`)
    return (body.wallets ?? []).map(normalizeWallet)
  }

  /** Adds an account-level payout address for one coin. */
  addWallet(cryptocurrency: string, address: string, label?: string): Promise<unknown> {
    return this.call('POST', '/api/wallets', { cryptocurrency: walletCode(cryptocurrency), wallet_address: address.trim(), label, is_active: true })
  }

  /** Copies the account's payout wallets into a business. */
  importWallets(businessId: string, cryptocurrencies?: string[]): Promise<{ imported: number; skipped: number }> {
    return this.call('POST', `/api/businesses/${encodeURIComponent(businessId)}/wallets/import`, cryptocurrencies ? { cryptocurrencies: cryptocurrencies.map(walletCode) } : { all: true })
  }

  /** A payment somebody can pay now: an address, an exact amount, and a deadline. */
  async createPayment(input: {
    businessId: string
    amountUsd: number
    currency: string
    description?: string
    metadata?: Record<string, unknown>
    redirectUrl?: string
    expiresInMinutes?: number
    idempotencyKey?: string
  }): Promise<Payment> {
    const body = await this.call<{ payment: any }>(
      'POST',
      '/api/payments/create',
      {
        business_id: input.businessId,
        amount_usd: input.amountUsd,
        currency: input.currency,
        description: input.description,
        metadata: input.metadata,
        redirect_url: input.redirectUrl,
        expires_in_minutes: input.expiresInMinutes,
      },
      input.idempotencyKey ? { 'idempotency-key': input.idempotencyKey } : {},
    )
    return this.toPayment(body.payment)
  }

  /** A payment's status; public, needs no token. */
  async payment(id: string): Promise<Payment> {
    const body = await this.call<{ payment?: any }>('GET', `/api/payments/${encodeURIComponent(id)}`)
    return this.toPayment(body.payment ?? body)
  }

  private toPayment(p: any): Payment {
    return {
      id: String(p.id),
      status: String(p.status ?? 'pending'),
      address: String(p.payment_address ?? p.address ?? ''),
      amountUsd: Number(p.amount_usd ?? p.amount ?? 0),
      amountCrypto: String(p.amount_crypto ?? p.crypto_amount ?? ''),
      currency: String(p.currency ?? p.blockchain ?? '').toLowerCase(),
      blockchain: String(p.blockchain ?? ''),
      expiresAt: p.expires_at ?? null,
      checkoutUrl: `${this.base}/pay/${p.id}`,
    }
  }
}

function normalizeWallet(w: any): Wallet {
  return { ...w, address: String(w.address ?? w.wallet_address ?? ''), cryptocurrency: String(w.cryptocurrency ?? w.chain ?? '').toUpperCase() }
}

export type OnboardInput = {
  /** The business to find or make, by exact name. */
  businessName: string
  category?: string
  description?: string
  /** Where CoinPay posts payment events. */
  webhookUrl?: string
  /** Payout addresses to add to the account first: { usdc_sol: 'So1…', btc: 'bc1…' }. */
  addresses?: Record<string, string>
  /** Copy the account's payout wallets into the business (default true). */
  importWallets?: boolean
}

export type OnboardStep = { step: string; ok: boolean; detail: string }

export type OnboardResult = {
  business: Business
  webhookSecret: string | null
  apiKey: string | null
  /** Coins this business can be paid in now. */
  coins: string[]
  steps: OnboardStep[]
}

/**
 * Everything a merchant needs to take crypto, made or found: payout addresses,
 * a business, its wallets, its webhook. A step CoinPay refuses is reported and
 * the rest still run, so one missing permission does not hide the others.
 */
export async function onboard(client: CoinPay, input: OnboardInput): Promise<OnboardResult> {
  const steps: OnboardStep[] = []
  const record = (step: string, ok: boolean, detail: string) => steps.push({ step, ok, detail })
  const failed = (error: unknown) => (error instanceof Error ? error.message : String(error))

  for (const [coin, address] of Object.entries(input.addresses ?? {})) {
    if (!address?.trim()) continue
    try {
      await client.addWallet(coin, address)
      record(`wallet:${coin}`, true, `payout address for ${walletCode(coin)} saved`)
    } catch (error) {
      const message = failed(error)
      // Already there is what we wanted.
      record(`wallet:${coin}`, /exist|already|duplicate/i.test(message), message)
    }
  }

  let business = (await client.businesses()).find((b) => b.name === input.businessName)
  const webhookSecret = randomBytes(32).toString('hex')
  let madeSecret: string | null = null
  if (business) {
    record('business', true, `found "${business.name}"`)
  } else {
    business = await client.createBusiness({
      name: input.businessName,
      category: input.category ?? 'other',
      ...(input.description ? { description: input.description } : {}),
      ...(input.webhookUrl ? { webhook_url: input.webhookUrl, webhook_secret: webhookSecret } : {}),
    })
    if (input.webhookUrl) madeSecret = webhookSecret
    record('business', true, `made "${business.name}"`)
  }

  if (input.importWallets !== false) {
    try {
      const r = await client.importWallets(business.id)
      record('import', true, `${r.imported} wallet(s) copied into the business, ${r.skipped} already there`)
    } catch (error) {
      record('import', false, failed(error))
    }
  }

  if (input.webhookUrl && business.webhook_url !== input.webhookUrl && !madeSecret) {
    try {
      business = { ...business, ...(await client.updateBusiness(business.id, { webhook_url: input.webhookUrl })) }
      record('webhook', true, `events go to ${input.webhookUrl}`)
    } catch (error) {
      record('webhook', false, failed(error))
    }
  } else if (input.webhookUrl) {
    record('webhook', true, `events go to ${input.webhookUrl}`)
  }

  let secret = madeSecret
  if (!secret && input.webhookUrl) {
    try {
      secret = await client.webhookSecret(business.id)
      record('webhook-secret', true, 'webhook secret read')
    } catch (error) {
      record('webhook-secret', false, failed(error))
    }
  }

  let coins: string[] = []
  try {
    const wallets = await client.wallets('all', business.id)
    coins = [...new Set(wallets.map((w) => String(w.cryptocurrency).toLowerCase()).filter(Boolean))]
    record('coins', coins.length > 0, coins.length ? `can be paid in ${coins.join(', ')}` : 'no payout addresses yet: add one to take payments')
  } catch (error) {
    record('coins', false, failed(error))
  }

  return { business, webhookSecret: secret, apiKey: typeof business.api_key === 'string' ? business.api_key : null, coins, steps }
}

/** Which of our coin ids a set of payout wallets can be paid in. */
export function payableCoins(walletCodes: string[]): CoinId[] {
  const have = new Set(walletCodes.map((c) => c.toUpperCase()))
  return COINS.filter((c) => have.has(c.id.toUpperCase())).map((c) => c.id)
}

/**
 * Checks a CoinPay webhook: `X-CoinPay-Signature: t=<unix>,v1=<hex>` is
 * HMAC-SHA256 of `${t}.${rawBody}` with the business's secret, within 5 minutes.
 */
export function verifyWebhook(rawBody: string, header: string | null | undefined, secret: string, now = Date.now(), toleranceSeconds = 300): boolean {
  if (!header || !secret) return false
  const parts = Object.fromEntries(header.split(',').map((kv) => kv.trim().split('=') as [string, string]))
  const t = Number(parts.t)
  const v1 = parts.v1
  if (!Number.isFinite(t) || !v1 || !/^[0-9a-f]+$/i.test(v1)) return false
  if (Math.abs(now / 1000 - t) > toleranceSeconds) return false
  const expected = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex')
  const a = Buffer.from(expected, 'hex')
  const b = Buffer.from(v1, 'hex')
  return a.length === b.length && timingSafeEqual(a, b)
}

/** Signs a body the way CoinPay does; for tests and for relaying events onward. */
export function signWebhook(rawBody: string, secret: string, now = Date.now()): string {
  const t = Math.floor(now / 1000)
  return `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex')}`
}

export type WebhookEvent = {
  id: string
  type: string
  created_at?: string
  business_id?: string
  data: { payment_id: string; status: string; amount_usd?: number | string; amount_crypto?: string; currency?: string; tx_hash?: string; metadata?: Record<string, unknown>; [k: string]: unknown }
}

/** The event's payment id: the payload is nested, and the top-level id is the EVENT. */
export function eventPaymentId(event: WebhookEvent): string {
  return String(event.data?.payment_id ?? '')
}
