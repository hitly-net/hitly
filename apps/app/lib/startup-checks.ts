import { productionAuthSecretProblem } from './auth-secret'
import { MAX_TRUSTED_PROXY_COUNT, TRUSTED_PROXY_COUNT_ENV, trustedProxyCount } from './client-address'
import { TRUSTED_PROXIES_ENV, parseTrustedProxies, trustedProxiesProblem } from './trusted-proxies'

/**
 * Server start checks, run from instrumentation register() before anything
 * else starts. Any problem stops the process with a short message that names
 * the variable but never its value.
 *
 * Production only (NODE_ENV exactly 'production'):
 * - BETTER_AUTH_SECRET must be usable (lib/auth-secret.ts).
 * - DATABASE_URL must not carry a development or placeholder password.
 * Every environment:
 * - HITLY_TRUSTED_PROXIES, when set, must be a list of IPs or CIDR ranges.
 */

/** Passwords from the local development setup and examples; never acceptable in production. */
export const PLACEHOLDER_DATABASE_PASSWORDS: ReadonlySet<string> = new Set([
  'hitly',
  'postgres',
  'password',
  'changeme',
  'change-me',
  'replace-me',
  'placeholder',
])

/** Why DATABASE_URL's password is unusable in production, or null. Never includes the value. */
export function productionDatabasePasswordProblem(value: string | undefined): string | null {
  const raw = (value ?? '').trim()
  if (!raw) return null // no database configured
  let password: string
  try {
    password = decodeURIComponent(new URL(raw).password)
  } catch {
    return 'DATABASE_URL is not a valid connection URL'
  }
  if (password && PLACEHOLDER_DATABASE_PASSWORDS.has(password.toLowerCase())) {
    return 'DATABASE_URL uses a development or placeholder password; set a unique password in production'
  }
  return null
}

export function startupProblems(env: Record<string, string | undefined> = process.env): string[] {
  const problems: string[] = []
  if (env.NODE_ENV === 'production') {
    const secret = productionAuthSecretProblem((env.BETTER_AUTH_SECRET ?? '').trim())
    if (secret) problems.push(secret)
    const database = productionDatabasePasswordProblem(env.DATABASE_URL)
    if (database) problems.push(database)
  }
  const proxies = trustedProxiesProblem(env)
  if (proxies) problems.push(proxies)
  return problems
}

/** Logs each problem and exits with status 1 when there are any. */
export function exitOnStartupProblems({
  env = process.env,
  log = (line: string) => console.error(line),
  exit = (code: number): never => process.exit(code),
}: {
  env?: Record<string, string | undefined>
  log?: (line: string) => void
  exit?: (code: number) => never
} = {}): void {
  const problems = startupProblems(env)
  if (problems.length === 0) return
  for (const problem of problems) log(`[hitly startup] ${problem}; refusing to start.`)
  exit(1)
}

/**
 * Start-up notes about client addresses: the effective trusted proxy setting
 * (a count, never addresses), and a warning when there is no per-client
 * address at all.
 */
export function startupNotices(env: Record<string, string | undefined> = process.env): {
  info: string[]
  warn: string[]
} {
  const info: string[] = []
  const warn: string[] = []
  let list = null
  try {
    list = parseTrustedProxies(env[TRUSTED_PROXIES_ENV])
  } catch {
    return { info, warn } // reported by startupProblems
  }
  if (list) {
    const n = list.entries.length
    info.push(`[hitly startup] Client addresses: ${n} trusted proxy ${n === 1 ? 'entry' : 'entries'} from ${TRUSTED_PROXIES_ENV}.`)
    return { info, warn }
  }
  const count = trustedProxyCount(env)
  info.push(`[hitly startup] Client addresses: ${TRUSTED_PROXY_COUNT_ENV} is ${count}.`)
  const raw = env[TRUSTED_PROXY_COUNT_ENV]?.trim()
  if (raw && /^\d+$/.test(raw) && Number(raw) > MAX_TRUSTED_PROXY_COUNT) {
    warn.push(`[hitly startup] ${TRUSTED_PROXY_COUNT_ENV} is above ${MAX_TRUSTED_PROXY_COUNT}; using ${MAX_TRUSTED_PROXY_COUNT}.`)
  }
  if (count === 0) {
    warn.push(
      `[hitly startup] ${TRUSTED_PROXY_COUNT_ENV} is 0, so requests have no per-client address; ` +
        'per-client limits use one shared ceiling. Put a reverse proxy in front and set the count or ' +
        `${TRUSTED_PROXIES_ENV}.`,
    )
  }
  return { info, warn }
}

export function logStartupNotices({
  env = process.env,
  info = (line: string) => console.info(line),
  warn = (line: string) => console.warn(line),
}: {
  env?: Record<string, string | undefined>
  info?: (line: string) => void
  warn?: (line: string) => void
} = {}): void {
  const notices = startupNotices(env)
  notices.info.forEach(info)
  notices.warn.forEach(warn)
}
