# @profullstack/coinpay-onboard

Take crypto on [CoinPay](https://coinpayportal.com), set up in one pass. The
onboarding behind [pay.agent](https://pay.agent) and every fleet site launch.

One engine, idempotent (run it twice, it finds what it made):

1. payout addresses on the account (optional)
2. a business, found by name or made
3. the account's payout wallets copied into it
4. its webhook pointed where you say, and the secret
5. which coins it can be paid in now

## At site launch

```sh
npx @profullstack/coinpay-onboard site example.agent --webhook https://example.agent/hooks/coinpay
```

Logs in as the merchant (`COINPAY_EMAIL` + `COINPAY_PASSWORD`, else the
`profullstack-private-secrets--prod` vault), then writes `COINPAY_API_URL`,
`COINPAY_BUSINESS_ID`, `COINPAY_API_KEY` and `COINPAY_WEBHOOK_SECRET` into the
site's logicsrc vault (`profullstack/example-agent--prod`). `--no-vault` prints
them instead.

## In an app (Sign in with CoinPay)

```ts
import { CoinPay, onboard, verifyWebhook } from '@profullstack/coinpay-onboard'
import { authorizeUrl, exchangeCode, pkce, refresh } from '@profullstack/coinpay-onboard/oauth'

// 1. send them to CoinPay (scopes: openid profile email wallet:read merchant)
const { verifier, challenge } = pkce()
redirect(authorizeUrl({ clientId, redirectUri, state, challenge }))

// 2. back with ?code=: tokens (1 h), refresh token (30 d, single-use: keep the newest)
const tokens = await exchangeCode({ code, verifier, clientId, redirectUri })

// 3. everything they need, in one call
const coinpay = new CoinPay({ token: tokens.accessToken })
const ready = await onboard(coinpay, { businessName: 'pay.agent/alice', webhookUrl: 'https://pay.agent/hooks/coinpay' })

// 4. take a payment
const payment = await coinpay.createPayment({ businessId: ready.business.id, amountUsd: 5, currency: 'usdc_sol' })
// payment.address, payment.amountCrypto, payment.expiresAt

// 5. hear about it
verifyWebhook(rawBody, req.headers['x-coinpay-signature'], ready.webhookSecret!)
```

## Sign in with CoinPay on a relying party

Confidential client, auth code + PKCE S256 + `state` + `nonce`, scopes `openid profile email`.

```ts
import { authorizeUrl, finishSignIn, pkce, randomToken, sameState, SIGN_IN_SCOPES } from '@profullstack/coinpay-onboard/oauth'

// start: keep verifier, state and nonce server-side (or in a signed httpOnly cookie)
const { verifier, challenge } = pkce()
const state = randomToken(), nonce = randomToken()
redirect(authorizeUrl({ clientId, redirectUri, state, nonce, challenge, scopes: SIGN_IN_SCOPES }))

// callback: state must match, then code exchange + id_token checks (iss, aud, exp, nonce) + userinfo
if (!sameState(saved.state, query.state)) throw new Error('bad state')
const { sub, email, name } = await finishSignIn({ code, verifier, nonce, clientId, clientSecret, redirectUri })
```

STANDING rule: bind the local account to `sub` only. The CoinPay `email` is unverified
contact information: never sign into an existing account because the email matches,
never store it as a verified account email, never grant anything from it. Link CoinPay
to an existing account only while the user is signed in to it.

Applications can use `@profullstack/coinpay-onboard/identity` for consistent
account-link policy. A CoinPay identity may be linked by its owner to multiple
local accounts; a local account may still link only one CoinPay identity. If a
CoinPay sign-in maps to multiple local accounts, use `resolveCoinPaySignIn()` to
present an authenticated account chooser instead of choosing an account implicitly.

## Hosted checkout (any coin or PayPal)

The buyer picks the method on CoinPay's page; the site never builds a chain picker.

```ts
import { CoinPay, readWebhook, verifyWebhook } from '@profullstack/coinpay-onboard'

const coinpay = new CoinPay({ token: process.env.COINPAY_API_KEY }) // the business cp_live_ key
const session = await coinpay.createCheckoutSession({
  amount: 19,                         // USD
  description: 'Pro plan, 1 month',
  customerEmail: user.email,          // required
  accountId: user.id,                 // required; use the email for guests
  property: 'example.com',            // the site hostname
  metadata: { plan: 'pro' },
  successUrl: 'https://example.com/billing?session={CHECKOUT_SESSION_ID}',
  cancelUrl: 'https://example.com/pricing',
})
redirect(session.url)                 // https://coinpayportal.com/checkout/cs_...

// webhook
if (!verifyWebhook(rawBody, req.headers['x-coinpay-signature'], secret)) return 401
const event = readWebhook(JSON.parse(rawBody))
if (event.paid) grant(event.accountId, event.metadata, event.checkoutSessionId)
```

`readWebhook` reads the nested `data` (the top-level id is the event, not the
payment), treats `payment.confirmed` and `payment.forwarded` as paid, and a
PayPal capture (`payment.confirmed`, status `completed`, `method: 'paypal'`)
the same. `coinpay.checkoutSession(id)` polls a session; with the business key
it carries the payer fields and payment ids. With an OAuth token, pass
`businessId`.

## CLI and MCP

```
coinpay-onboard site <name> --webhook URL   launch step, keys into the vault
coinpay-onboard pay <business-id> <usd> [coin]
coinpay-onboard status <payment-id>
coinpay-onboard coins
coinpay-onboard mcp                          claude mcp add coinpay-onboard -- npx @profullstack/coinpay-onboard mcp
```

MIT
