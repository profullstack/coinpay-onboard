/**
 * `coinpay-onboard mcp`: onboarding and payments for an agent, on stdio.
 *
 *   claude mcp add coinpay-onboard -- bunx @profullstack/coinpay-onboard mcp
 *
 * Signs in as the merchant the way the CLI does (COINPAY_TOKEN, or
 * COINPAY_EMAIL + COINPAY_PASSWORD, or the vault).
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { COINS, CoinPay, onboard } from './index.js'
import { merchantClient, runSite } from './cli.js'
import { VERSION } from './version.js'

const text = (value: unknown) => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] })
const failure = (error: unknown) => ({ isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }] })

export function createMcpServer(client: () => Promise<CoinPay> = () => merchantClient()): McpServer {
  // Typed loosely: the SDK's generic tool() recurses past TypeScript's depth with zod shapes.
  const server: any = new McpServer({ name: 'coinpay-onboard', version: VERSION })

  server.tool(
    'onboard_site',
    'Launch step for a site: find or make its CoinPay business, copy payout wallets in, point the webhook, and write COINPAY_* keys into the site vault (unless vault is false).',
    { name: z.string().min(1).max(100), webhook: z.string().url(), category: z.string().optional(), vault: z.boolean().optional() },
    async ({ name, webhook, category, vault }: { name: string; webhook: string; category?: string; vault?: boolean }) => {
      try {
        const lines: string[] = []
        const code = await runSite(name, { webhook, ...(category ? { category } : {}), ...(vault === false ? { vault: 'false' } : {}) }, { log: (t) => lines.push(t), error: (t) => lines.push(t) }, { client: await client() })
        return code === 2 ? failure(lines.join('\n')) : text(lines.join('\n'))
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.tool(
    'onboard',
    'Ready the signed-in merchant to take crypto: payout addresses, a business by name, wallets copied in, webhook. Returns each step.',
    { business: z.string().min(1).max(100), webhook: z.string().url().optional(), addresses: z.record(z.string(), z.string()).optional() },
    async ({ business, webhook, addresses }: { business: string; webhook?: string; addresses?: Record<string, string> }) => {
      try {
        const r = await onboard(await client(), { businessName: business, ...(webhook ? { webhookUrl: webhook } : {}), ...(addresses ? { addresses } : {}) })
        return text({ business: { id: r.business.id, name: r.business.name }, coins: r.coins, steps: r.steps })
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.tool(
    'create_payment',
    'A payment to pay now: returns the address, exact crypto amount and expiry.',
    { business_id: z.string().min(1), amount_usd: z.number().positive(), coin: z.string().default('usdc_sol'), description: z.string().max(500).optional() },
    async ({ business_id, amount_usd, coin, description }: { business_id: string; amount_usd: number; coin: string; description?: string }) => {
      try {
        return text(await (await client()).createPayment({ businessId: business_id, amountUsd: amount_usd, currency: coin, ...(description ? { description } : {}) }))
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.tool('payment_status', 'A payment\'s status (public).', { payment_id: z.string().min(1) }, async ({ payment_id }: { payment_id: string }) => {
    try {
      return text(await new CoinPay({ base: process.env.COINPAY_BASE }).payment(payment_id))
    } catch (error) {
      return failure(error)
    }
  })

  server.tool('coins', 'What CoinPay takes payment in.', {}, async () => text(COINS))
  return server
}

export async function runMcp(): Promise<void> {
  await createMcpServer().connect(new StdioServerTransport())
}
