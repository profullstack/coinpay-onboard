import { VERSION } from './version.js'

const env = (name: string): string => {
  try {
    const v = (globalThis as any).process?.env?.[name]
    return typeof v === 'string' && v.trim() ? v.trim() : ''
  } catch {
    return ''
  }
}

/**
 * The User-Agent CoinPay sees from this app: `<app>/<version> (+<site>) coinpay-onboard/<v>`.
 *
 * Every Profullstack site runs on one host, so the runtime default (`Bun/1.4.4`,
 * `node`) made them one caller in CoinPay's logs. The app name and version come
 * from `COINPAY_APP_NAME` or npm/bun run (`npm_package_name`, `npm_package_version`),
 * the site from the usual origin variables; `COINPAY_USER_AGENT` replaces it whole.
 */
export function defaultUserAgent(): string {
  const override = env('COINPAY_USER_AGENT')
  if (override) return override
  const site = ['COINPAY_APP_URL', 'APP_URL', 'SITE_URL', 'PUBLIC_SITE_URL', 'NEXT_PUBLIC_SITE_URL', 'NEXT_PUBLIC_APP_URL', 'PUBLIC_ORIGIN', 'ORIGIN', 'BASE_URL']
    .map(env)
    .find((v) => /^https?:\/\//.test(v))
    ?.replace(/\/+$/, '')
  let name = env('COINPAY_APP_NAME') || env('npm_package_name').replace(/^@[^/]+\//, '')
  if (!name && site) {
    try {
      name = new URL(site).hostname
    } catch {}
  }
  const version = env('npm_package_version')
  const product = name ? (version ? `${name}/${version}` : name) : ''
  return [product, site ? `(+${site})` : '', `coinpay-onboard/${VERSION}`].filter(Boolean).join(' ')
}

/** Headers with `user-agent` added unless the caller already set one. */
export function withUserAgent(headers: Record<string, string>, userAgent: string = defaultUserAgent()): Record<string, string> {
  if (!userAgent || Object.keys(headers).some((k) => k.toLowerCase() === 'user-agent')) return headers
  return { ...headers, 'user-agent': userAgent }
}
