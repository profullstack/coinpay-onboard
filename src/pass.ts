/**
 * Profullstack Pass: a user who deposits $99 into their own CoinPay wallet gets
 * a free month on every Profullstack property. CoinPay reports it as a `pass`
 * claim on GET /api/oauth/userinfo (scope `openid`):
 *
 *   "pass": { "active": true, "expires_at": "2026-12-07T18:00:00.000Z" }
 *   "pass": { "active": false }
 *   (absent: an older CoinPay, or the lookup failed)
 *
 * Give full/paid access while it is active, then fall back to the site's normal
 * pay-as-you-go crypto checkout. Send people without one to PASS_URL.
 */

/** Where a user gets a Profullstack Pass. */
export const PASS_URL = 'https://coinpayportal.com/pass'

export type CoinpayPass = { active: boolean; expiresAt: Date | null }

/**
 * Reads the `pass` claim out of a userinfo body. Defensive: anything missing or
 * malformed is no pass, and `active: true` counts only with an `expires_at` that
 * parses and is still in the future.
 */
export function passFromUserinfo(claims: unknown, now: Date = new Date()): CoinpayPass {
  if (!claims || typeof claims !== 'object') return { active: false, expiresAt: null }
  const pass = (claims as Record<string, unknown>).pass
  if (!pass || typeof pass !== 'object') return { active: false, expiresAt: null }
  const { active, expires_at } = pass as Record<string, unknown>
  const parsed = typeof expires_at === 'string' && expires_at.trim() ? new Date(expires_at) : null
  const expiresAt = parsed && Number.isFinite(parsed.getTime()) ? parsed : null
  const live = active === true && expiresAt !== null && expiresAt.getTime() > now.getTime()
  return { active: live, expiresAt }
}

/** True while the user holds an active Profullstack Pass. */
export function hasPassAccess(claims: unknown, now: Date = new Date()): boolean {
  return passFromUserinfo(claims, now).active
}
