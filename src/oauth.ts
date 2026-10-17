/**
 * Sign in with CoinPay: authorization code + PKCE (S256), the only method
 * CoinPay accepts. Tokens last an hour; refresh tokens last 30 days and are
 * single-use (each refresh returns a new one), so keep the newest.
 */
import { createHash, randomBytes } from 'node:crypto'
import { DEFAULT_BASE } from './index.js'

/** What onboarding needs: who you are, your payout wallets, and acting as your merchant account. */
export const ONBOARD_SCOPES = ['openid', 'profile', 'email', 'wallet:read', 'merchant']

export type Tokens = { accessToken: string; refreshToken: string | null; expiresAt: number; scope: string }

const b64url = (buffer: Buffer) => buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

export function pkce(): { verifier: string; challenge: string } {
  const verifier = b64url(randomBytes(32))
  return { verifier, challenge: b64url(createHash('sha256').update(verifier).digest()) }
}

export function authorizeUrl(input: { clientId: string; redirectUri: string; state: string; challenge: string; scopes?: string[]; base?: string }): string {
  const url = new URL('/api/oauth/authorize', input.base ?? DEFAULT_BASE)
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    scope: (input.scopes ?? ONBOARD_SCOPES).join(' '),
    state: input.state,
    code_challenge: input.challenge,
    code_challenge_method: 'S256',
  }).toString()
  return url.toString()
}

async function tokenRequest(params: Record<string, string>, base: string, doFetch: typeof fetch, now: number): Promise<Tokens> {
  const response = await doFetch(new URL('/api/oauth/token', base), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams(params).toString(),
    signal: AbortSignal.timeout(20_000),
  })
  const body = (await response.json().catch(() => ({}))) as Record<string, any>
  if (!response.ok || !body.access_token) throw new Error(body.error_description ?? body.error ?? `CoinPay token endpoint answered ${response.status}`)
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token ?? null,
    expiresAt: now + Number(body.expires_in ?? 3600) * 1000,
    scope: String(body.scope ?? ''),
  }
}

export function exchangeCode(input: { code: string; verifier: string; clientId: string; clientSecret?: string; redirectUri: string; base?: string; fetch?: typeof fetch; now?: number }): Promise<Tokens> {
  return tokenRequest(
    {
      grant_type: 'authorization_code',
      code: input.code,
      code_verifier: input.verifier,
      client_id: input.clientId,
      redirect_uri: input.redirectUri,
      ...(input.clientSecret ? { client_secret: input.clientSecret } : {}),
    },
    input.base ?? DEFAULT_BASE,
    input.fetch ?? fetch,
    input.now ?? Date.now(),
  )
}

export function refresh(input: { refreshToken: string; clientId: string; clientSecret?: string; base?: string; fetch?: typeof fetch; now?: number }): Promise<Tokens> {
  return tokenRequest(
    {
      grant_type: 'refresh_token',
      refresh_token: input.refreshToken,
      client_id: input.clientId,
      ...(input.clientSecret ? { client_secret: input.clientSecret } : {}),
    },
    input.base ?? DEFAULT_BASE,
    input.fetch ?? fetch,
    input.now ?? Date.now(),
  )
}
