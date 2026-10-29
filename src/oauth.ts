/**
 * Sign in with CoinPay: authorization code + PKCE (S256), the only method
 * CoinPay accepts. Tokens last an hour; refresh tokens last 30 days and are
 * single-use (each refresh returns a new one), so keep the newest.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { DEFAULT_BASE } from './index.js'

/** What onboarding needs: who you are, your payout wallets, and acting as your merchant account. */
export const ONBOARD_SCOPES = ['openid', 'profile', 'email', 'wallet:read', 'merchant']

/** What "Sign in with CoinPay" on a relying party needs: who you are, nothing more. */
export const SIGN_IN_SCOPES = ['openid', 'profile', 'email']

export type Tokens = {
  accessToken: string
  refreshToken: string | null
  expiresAt: number
  scope: string
  /** The OIDC id_token when `openid` was granted; check it with checkIdToken(). */
  idToken: string | null
}

/** A random value for `state` or `nonce` (32 bytes, base64url). */
export function randomToken(bytes = 32): string {
  return b64url(randomBytes(bytes))
}

function b64url(buffer: Buffer): string {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function pkce(): { verifier: string; challenge: string } {
  const verifier = b64url(randomBytes(32))
  return { verifier, challenge: b64url(createHash('sha256').update(verifier).digest()) }
}

export function authorizeUrl(input: { clientId: string; redirectUri: string; state: string; challenge: string; nonce?: string; scopes?: string[]; base?: string }): string {
  const url = new URL('/api/oauth/authorize', input.base ?? DEFAULT_BASE)
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    scope: (input.scopes ?? ONBOARD_SCOPES).join(' '),
    state: input.state,
    code_challenge: input.challenge,
    code_challenge_method: 'S256',
    ...(input.nonce ? { nonce: input.nonce } : {}),
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
    idToken: typeof body.id_token === 'string' ? body.id_token : null,
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

export type IdTokenClaims = {
  iss: string
  sub: string
  aud: string | string[]
  exp: number
  iat?: number
  nonce?: string
  /** Contact information only: CoinPay does not verify addresses (email_verified is always false). */
  email?: string
  email_verified?: boolean
  name?: string
  preferred_username?: string
  picture?: string
  [claim: string]: unknown
}

function constantTimeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

/** Constant-time comparison for `state` values; false when either is missing. */
export function sameState(expected: string | null | undefined, received: string | null | undefined): boolean {
  return Boolean(expected) && Boolean(received) && constantTimeEqual(String(expected), String(received))
}

/**
 * Checks the claims of the id_token the token endpoint returned: issuer, audience
 * (this client), expiry, and the nonce the authorization request sent. Throws when
 * any of them is wrong.
 *
 * It does not check the signature: CoinPay signs id_tokens with HS256 under its own
 * key, which relying parties never hold. OIDC Core 3.1.3.7 allows TLS server
 * validation in place of the signature for a token received directly from the token
 * endpoint, which is the only place this should be fed from (never the browser).
 */
export function checkIdToken(input: { idToken: string | null | undefined; clientId: string; nonce: string; issuer?: string; now?: number; leewaySeconds?: number }): IdTokenClaims {
  if (!input.idToken) throw new Error('CoinPay returned no id_token (was the openid scope granted?)')
  const parts = input.idToken.split('.')
  if (parts.length !== 3) throw new Error('id_token is not a JWT')
  let claims: IdTokenClaims
  try {
    claims = JSON.parse(Buffer.from(parts[1] ?? '', 'base64url').toString('utf8'))
  } catch {
    throw new Error('id_token payload is not JSON')
  }
  if (!claims || typeof claims !== 'object') throw new Error('id_token payload is not an object')
  const trim = (value: string) => value.replace(/\/+$/, '')
  if (typeof claims.iss !== 'string' || trim(claims.iss) !== trim(input.issuer ?? DEFAULT_BASE)) throw new Error('id_token issuer mismatch')
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
  if (!audiences.includes(input.clientId)) throw new Error('id_token audience mismatch')
  const now = Math.floor((input.now ?? Date.now()) / 1000)
  const leeway = input.leewaySeconds ?? 60
  if (typeof claims.exp !== 'number' || claims.exp + leeway < now) throw new Error('id_token expired')
  if (typeof claims.nonce !== 'string' || !input.nonce || !constantTimeEqual(claims.nonce, input.nonce)) throw new Error('id_token nonce mismatch')
  if (typeof claims.sub !== 'string' || !claims.sub) throw new Error('id_token has no sub')
  return claims
}

export type UserInfo = {
  sub: string
  /** Contact information only: never treat it as a verified or unique account email. */
  email?: string
  email_verified?: boolean
  name?: string
  preferred_username?: string
  picture?: string
  [claim: string]: unknown
}

/** GET /api/oauth/userinfo with the access token. */
export async function userinfo(input: { accessToken: string; base?: string; fetch?: typeof fetch }): Promise<UserInfo> {
  const response = await (input.fetch ?? fetch)(new URL('/api/oauth/userinfo', input.base ?? DEFAULT_BASE), {
    headers: { authorization: `Bearer ${input.accessToken}`, accept: 'application/json' },
    signal: AbortSignal.timeout(20_000),
  })
  const body = (await response.json().catch(() => ({}))) as Record<string, any>
  if (!response.ok || typeof body.sub !== 'string' || !body.sub) throw new Error(body.error_description ?? body.error ?? `CoinPay userinfo answered ${response.status}`)
  return body as UserInfo
}

/**
 * The second half of "Sign in with CoinPay" on a relying party: exchanges the code,
 * checks the id_token (issuer, audience, expiry, nonce) and reads userinfo, whose
 * `sub` must match. Bind the result to a local account by `sub` only; the email is
 * unverified contact information (see the STANDING rule in the README).
 */
export async function finishSignIn(input: {
  code: string
  verifier: string
  nonce: string
  clientId: string
  clientSecret: string
  redirectUri: string
  base?: string
  /** Expected id_token `iss`; defaults to `base`. */
  issuer?: string
  fetch?: typeof fetch
  now?: number
}): Promise<{ sub: string; email: string | null; name: string | null; claims: IdTokenClaims; userinfo: UserInfo; tokens: Tokens }> {
  const base = input.base ?? DEFAULT_BASE
  const tokens = await exchangeCode({ code: input.code, verifier: input.verifier, clientId: input.clientId, clientSecret: input.clientSecret, redirectUri: input.redirectUri, base, fetch: input.fetch, now: input.now })
  const claims = checkIdToken({ idToken: tokens.idToken, clientId: input.clientId, nonce: input.nonce, issuer: input.issuer ?? base, now: input.now })
  const info = await userinfo({ accessToken: tokens.accessToken, base, fetch: input.fetch })
  if (info.sub !== claims.sub) throw new Error('userinfo sub does not match the id_token')
  const email = typeof info.email === 'string' && info.email ? info.email : typeof claims.email === 'string' && claims.email ? claims.email : null
  const name = [info.name, info.preferred_username, claims.name].find((value): value is string => typeof value === 'string' && value.trim() !== '') ?? null
  return { sub: claims.sub, email, name, claims, userinfo: info, tokens }
}
