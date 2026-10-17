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

## CLI and MCP

```
coinpay-onboard site <name> --webhook URL   launch step, keys into the vault
coinpay-onboard pay <business-id> <usd> [coin]
coinpay-onboard status <payment-id>
coinpay-onboard coins
coinpay-onboard mcp                          claude mcp add coinpay-onboard -- npx @profullstack/coinpay-onboard mcp
```

MIT
