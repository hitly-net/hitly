import { APIError, isAPIError } from 'better-auth/api'

/**
 * Logging for Better Auth that never writes tokens.
 *
 * Better Auth logs a failed database query with its error message, and the
 * database driver's message includes the query parameters. For a password
 * reset submit, those include the verification identifier, which carries the
 * reset token. The same error is also printed by the request router when
 * Better Auth's error hook doesn't produce a response.
 *
 * This module provides:
 * - `authLogger`: Better Auth's `logger` option. Every message and argument is
 *   passed through `redactSecrets`, and errors are reduced to their name,
 *   code and redacted message (no stack).
 * - `handleAuthApiError`: Better Auth's `onAPIError.onError`. Unexpected
 *   errors are logged as one value-free line and turned into a plain 500, so
 *   the router never prints the raw error.
 */

const SECRET_PATTERNS: [RegExp, string][] = [
  // Driver messages: everything after "params:" is query parameters.
  [/\bparams:[\s\S]*$/gi, 'params: [redacted]'],
  // Verification identifiers such as reset-password:<token>.
  [/\b([a-z][a-z0-9-]*):([A-Za-z0-9_-]{8,})/g, '$1:[redacted]'],
  // Tokens in URLs or query strings.
  [/\b(token|code|state)=([^&\s"']+)/gi, '$1=[redacted]'],
]

export function redactSecrets(text: string): string {
  let out = text
  for (const [pattern, replacement] of SECRET_PATTERNS) out = out.replace(pattern, replacement)
  return out
}

function describeError(error: Error): string {
  const code = (error as { code?: unknown }).code
  const cause = (error as { cause?: unknown }).cause
  const causeCode = cause && typeof cause === 'object' ? (cause as { code?: unknown }).code : undefined
  const parts = [`${error.name}: ${redactSecrets(error.message)}`]
  if (typeof code === 'string') parts.push(`code=${code}`)
  if (typeof causeCode === 'string') parts.push(`cause=${causeCode}`)
  return parts.join(' ')
}

export function redactLogArg(arg: unknown): unknown {
  if (arg instanceof Error) return describeError(arg)
  if (typeof arg === 'string') return redactSecrets(arg)
  if (arg && typeof arg === 'object') {
    try {
      return redactSecrets(JSON.stringify(arg))
    } catch {
      return '[unprintable]'
    }
  }
  return arg
}

type LogLevel = 'debug' | 'info' | 'success' | 'warn' | 'error'

export function createAuthLogger(write: (level: LogLevel, line: string) => void = defaultWrite) {
  return {
    log: (level: LogLevel, message: string, ...args: unknown[]) => {
      const rest = args.map((arg) => String(redactLogArg(arg)))
      write(level, [`[Better Auth] ${redactSecrets(message)}`, ...rest].join(' '))
    },
  }
}

function defaultWrite(level: LogLevel, line: string) {
  if (level === 'error') console.error(line)
  else if (level === 'warn') console.warn(line)
  else console.info(line)
}

export const authLogger = createAuthLogger()

export const AUTH_REQUEST_FAILED_LOG = '[hitly auth] Request failed'

export function createAuthApiErrorHandler(log: (line: string) => void = (line) => console.error(line)) {
  return (error: unknown): void => {
    if (isAPIError(error) && error.status !== 'INTERNAL_SERVER_ERROR') throw error
    const detail = error instanceof Error ? describeError(error) : 'unknown error'
    log(`${AUTH_REQUEST_FAILED_LOG}: ${detail}`)
    throw new APIError('INTERNAL_SERVER_ERROR', { message: 'Something went wrong. Try again in a moment.' })
  }
}

export const handleAuthApiError = createAuthApiErrorHandler()
