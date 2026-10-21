/**
 * BETTER_AUTH_SECRET handling.
 *
 * Production requires a real secret: trimmed, at least 32 characters, and not
 * one of the documented placeholder values (compared case-insensitively). The requirement is checked at
 * server start (instrumentation register), so a misconfigured production
 * server refuses to start, and again whenever the auth instance is created. Outside
 * production a clearly-labelled development value keeps local runs and tests
 * working.
 */

export const AUTH_SECRET_MIN_LENGTH = 32

/** Development-only value used outside production when no secret is set. */
export const DEV_AUTH_SECRET = 'dev-only-change-me-please-32ch'

/** Placeholder values shipped in examples; never acceptable in production. */
export const PLACEHOLDER_AUTH_SECRETS: ReadonlySet<string> = new Set([
  DEV_AUTH_SECRET,
  'replace-me-with-a-32-char-secret',
])

const PLACEHOLDER_AUTH_SECRETS_LOWER: ReadonlySet<string> = new Set(
  [...PLACEHOLDER_AUTH_SECRETS].map((value) => value.toLowerCase()),
)

/**
 * Returns why a value is not usable as the production secret, or null when it
 * is. Never includes the value itself.
 */
export function productionAuthSecretProblem(value: string | undefined): string | null {
  const secret = (value ?? '').trim()
  if (!secret) return 'BETTER_AUTH_SECRET must be set in production'
  if (secret.length < AUTH_SECRET_MIN_LENGTH) {
    return `BETTER_AUTH_SECRET must be at least ${AUTH_SECRET_MIN_LENGTH} characters in production`
  }
  if (PLACEHOLDER_AUTH_SECRETS_LOWER.has(secret.toLowerCase())) {
    return 'BETTER_AUTH_SECRET is a placeholder value; set a unique secret in production'
  }
  return null
}

/**
 * Server start check: throws in production unless BETTER_AUTH_SECRET is
 * usable. Called from instrumentation register() before the server serves
 * requests.
 */
export function assertProductionAuthSecret(env: NodeJS.ProcessEnv = process.env): void {
  if (env.NODE_ENV !== 'production') return
  const problem = productionAuthSecretProblem((env.BETTER_AUTH_SECRET ?? '').trim())
  if (problem) throw new Error(`${problem}; refusing to start.`)
}

/**
 * Resolves the secret passed to the auth configuration (called when the auth
 * instance is first created, never while the module is only being loaded).
 * In production the trimmed secret must pass productionAuthSecretProblem;
 * there is no exemption. Outside production an unset secret falls back to the
 * development value.
 */
export function resolveAuthSecret(env: NodeJS.ProcessEnv = process.env): string {
  const secret = (env.BETTER_AUTH_SECRET ?? '').trim()
  if (env.NODE_ENV === 'production') {
    const problem = productionAuthSecretProblem(secret)
    if (problem) throw new Error(`${problem}; refusing to start.`)
    return secret
  }
  return secret || DEV_AUTH_SECRET
}
