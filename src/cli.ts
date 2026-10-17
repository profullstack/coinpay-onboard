/**
 * coinpay-onboard: ready a site or a person to take crypto on CoinPay.
 *
 *   coinpay-onboard site <name> --webhook URL    at launch: business, wallets, webhook, keys into the vault
 *   coinpay-onboard pay <business-id> <usd> [coin]   a payment to pay now (address + amount)
 *   coinpay-onboard status <payment-id>
 *   coinpay-onboard coins
 *   coinpay-onboard mcp                            MCP server on stdio
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { COINS, CoinPay, DEFAULT_BASE, onboard, type OnboardResult } from './index.js'
import { VERSION } from './version.js'

export const HELP = `coinpay-onboard ${VERSION}: take crypto on CoinPay, set up in one pass

  coinpay-onboard site <name> --webhook URL [options]
      Launch step for a fleet site: finds or makes the CoinPay business <name>,
      copies the merchant's payout wallets into it, points its webhook at URL,
      and writes COINPAY_API_URL, COINPAY_BUSINESS_ID, COINPAY_API_KEY and
      COINPAY_WEBHOOK_SECRET into the site's vault.
        --team T          logicsrc team (default profullstack)
        --vault P         vault project (default: <name> with dots as dashes)
        --env E           vault env (default prod)
        --category C      CoinPay business category (default saas)
        --no-vault        print the keys instead of writing the vault
  coinpay-onboard pay <business-id> <usd> [coin]   make a payment (coin default usdc_sol)
  coinpay-onboard status <payment-id>              a payment's status (public)
  coinpay-onboard coins                            what CoinPay takes
  coinpay-onboard mcp                              MCP server on stdio

  --json            machine-readable output
  Merchant login: COINPAY_EMAIL + COINPAY_PASSWORD, else the vault
  profullstack/profullstack-private-secrets--prod. COINPAY_TOKEN uses a token
  instead (OAuth with scope merchant, or a session). COINPAY_BASE for another CoinPay.
`

type Out = { log(text: string): void; error(text: string): void }

export function parseArgs(argv: string[]): { positional: string[]; flags: Record<string, string | true> } {
  const positional: string[] = []
  const flags: Record<string, string | true> = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg.startsWith('--no-')) flags[arg.slice(5)] = 'false'
    else if (arg.startsWith('--')) {
      const [key, inline] = arg.slice(2).split('=', 2) as [string, string | undefined]
      const next = argv[i + 1]
      if (inline !== undefined) flags[key] = inline
      else if (next !== undefined && !next.startsWith('--') && key !== 'json') flags[key] = (i++, next)
      else flags[key] = true
    } else positional.push(arg)
  }
  return { positional, flags }
}

/** KEY=value lines in, a map out; quotes stripped. */
export function parseEnv(text: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
    if (!m) continue
    let value = m[2]!.trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1)
    out.set(m[1]!, value)
  }
  return out
}

/** The env file with these keys set, every other line kept as it was. */
export function mergeEnv(text: string, set: Record<string, string>): string {
  const left = new Map(Object.entries(set))
  const lines = text.split(/\r?\n/).map((line) => {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line)
    if (m && left.has(m[1]!)) {
      const value = left.get(m[1]!)!
      left.delete(m[1]!)
      return `${m[1]}=${value}`
    }
    return line
  })
  while (lines.length && lines[lines.length - 1] === '') lines.pop()
  for (const [k, v] of left) lines.push(`${k}=${v}`)
  return lines.join('\n') + '\n'
}

type Vault = { pull(team: string, project: string, env: string): string; push(team: string, project: string, env: string, text: string): void }

/** The logicsrc CLI: pull a vault into a file, push a file into a vault. */
export const logicsrcVault: Vault = {
  pull(team, project, env) {
    const dir = mkdtempSync(join(tmpdir(), 'coinpay-onboard-'))
    try {
      const file = join(dir, '.env')
      try {
        execFileSync('logicsrc', ['teams', 'pull', team, project, env, '--env', file], { stdio: ['ignore', 'ignore', 'pipe'] })
      } catch (error) {
        // A vault that does not exist yet is an empty one; push makes it.
        if (/not found|no such|does not exist/i.test(String((error as { stderr?: Buffer }).stderr ?? ''))) return ''
        throw error
      }
      try {
        return readFileSync(file, 'utf8')
      } catch {
        return ''
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  },
  push(team, project, env, text) {
    const dir = mkdtempSync(join(tmpdir(), 'coinpay-onboard-'))
    try {
      const file = join(dir, '.env')
      writeFileSync(file, text, { mode: 0o600 })
      execFileSync('logicsrc', ['teams', 'push', team, project, env, '--env', file], { stdio: ['ignore', 'ignore', 'inherit'] })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  },
}

/** A client signed in as the merchant: COINPAY_TOKEN, else email + password from the env or the vault. */
export async function merchantClient(env: NodeJS.ProcessEnv = process.env, vault: Vault = logicsrcVault): Promise<CoinPay> {
  const base = env.COINPAY_BASE ?? DEFAULT_BASE
  if (env.COINPAY_TOKEN) return new CoinPay({ base, token: env.COINPAY_TOKEN })
  let email = env.COINPAY_EMAIL
  let password = env.COINPAY_PASSWORD
  if (!email || !password) {
    const secrets = parseEnv(vault.pull('profullstack', 'profullstack-private-secrets', 'prod'))
    email = secrets.get('COINPAY_EMAIL')
    password = secrets.get('COINPAY_PASSWORD')
  }
  if (!email || !password) throw new Error('No CoinPay merchant login: set COINPAY_EMAIL and COINPAY_PASSWORD, or COINPAY_TOKEN')
  return CoinPay.login(email, password, { base })
}

export function siteKeys(result: OnboardResult, base: string): Record<string, string> {
  return {
    COINPAY_API_URL: `${base}/api`,
    COINPAY_BUSINESS_ID: result.business.id,
    ...(result.apiKey ? { COINPAY_API_KEY: result.apiKey } : {}),
    ...(result.webhookSecret ? { COINPAY_WEBHOOK_SECRET: result.webhookSecret } : {}),
  }
}

export async function runSite(
  name: string,
  flags: Record<string, string | true>,
  out: Out,
  deps: { client?: CoinPay; vault?: Vault } = {},
): Promise<number> {
  const webhook = typeof flags.webhook === 'string' ? flags.webhook : undefined
  if (!webhook) {
    out.error('site needs --webhook URL: where CoinPay posts this site\'s payment events')
    return 2
  }
  const vault = deps.vault ?? logicsrcVault
  const client = deps.client ?? (await merchantClient(process.env, vault))
  const result = await onboard(client, {
    businessName: name,
    category: typeof flags.category === 'string' ? flags.category : 'saas',
    webhookUrl: webhook,
  })
  const keys = siteKeys(result, client.base)
  const team = typeof flags.team === 'string' ? flags.team : 'profullstack'
  const project = typeof flags.vault === 'string' && flags.vault !== 'false' ? flags.vault : name.replace(/\./g, '-')
  const env = typeof flags.env === 'string' ? flags.env : 'prod'
  const writeVault = flags.vault !== 'false'
  if (writeVault) vault.push(team, project, env, mergeEnv(vault.pull(team, project, env), keys))
  if (flags.json) {
    out.log(JSON.stringify({ business: { id: result.business.id, name: result.business.name }, coins: result.coins, steps: result.steps, vault: writeVault ? `${team}/${project}--${env}` : null, ...(writeVault ? {} : { keys }) }, null, 2))
  } else {
    for (const s of result.steps) out.log(`${s.ok ? '✓' : '✗'} ${s.step.padEnd(15)} ${s.detail}`)
    if (writeVault) out.log(`✓ vault           ${Object.keys(keys).join(', ')} -> ${team}/${project}--${env}`)
    else for (const [k, v] of Object.entries(keys)) out.log(`${k}=${v}`)
  }
  return result.steps.every((s) => s.ok) ? 0 : 1
}

export async function main(argv = process.argv.slice(2), out: Out = console): Promise<number> {
  const { positional, flags } = parseArgs(argv)
  const [command, ...rest] = positional
  try {
    switch (command) {
      case 'site':
        if (!rest[0]) break
        return await runSite(rest[0], flags, out)
      case 'pay': {
        const [businessId, usd, coin = 'usdc_sol'] = rest
        if (!businessId || !usd) break
        const client = await merchantClient()
        const p = await client.createPayment({ businessId, amountUsd: Number(usd), currency: coin })
        out.log(flags.json ? JSON.stringify(p, null, 2) : `Send ${p.amountCrypto} ${coin.toUpperCase()} to ${p.address}\n${p.checkoutUrl}`)
        return 0
      }
      case 'status': {
        if (!rest[0]) break
        const p = await new CoinPay({ base: process.env.COINPAY_BASE }).payment(rest[0])
        out.log(flags.json ? JSON.stringify(p, null, 2) : `${p.id}: ${p.status}`)
        return 0
      }
      case 'coins':
        out.log(flags.json ? JSON.stringify(COINS, null, 2) : COINS.map((c) => `${c.id.padEnd(10)} ${c.name}`).join('\n'))
        return 0
      case 'mcp': {
        const { runMcp } = await import('./mcp.js')
        await runMcp()
        return 0
      }
      case 'version':
      case '--version':
        out.log(VERSION)
        return 0
    }
    if (flags.version) {
      out.log(VERSION)
      return 0
    }
    out.log(HELP)
    return command ? 2 : 0
  } catch (error) {
    out.error(error instanceof Error ? error.message : String(error))
    return 1
  }
}
