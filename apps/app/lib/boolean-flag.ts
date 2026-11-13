/**
 * Shared parser for the app's boolean environment flags.
 *
 * Accepted values (compared after trim + lowercase):
 *   ON:  1, true, yes, on
 *   OFF: 0, false, off
 *   unset/empty: the flag's default
 *   anything else: the flag's default, plus ONE startup warning that names
 *   the variable but never its value (same policy as the other startup
 *   checks — see lib/startup-checks.ts).
 */

export const BOOLEAN_FLAG_TRUE_VALUES = ['1', 'true', 'yes', 'on'] as const
export const BOOLEAN_FLAG_FALSE_VALUES = ['0', 'false', 'off'] as const

/** The app's boolean flags and their defaults (closed-beta posture). */
export const BOOLEAN_FLAGS = [
  { name: 'HITLY_SIGNUP_ENABLED', defaultOn: true },
  { name: 'HITLY_REQUIRE_VERIFIED_EMAIL', defaultOn: false },
] as const

export function parseBooleanFlagValue(value: string | undefined, defaultOn: boolean): boolean {
  const normalized = (value ?? '').trim().toLowerCase()
  if (!normalized) return defaultOn
  if ((BOOLEAN_FLAG_TRUE_VALUES as readonly string[]).includes(normalized)) return true
  if ((BOOLEAN_FLAG_FALSE_VALUES as readonly string[]).includes(normalized)) return false
  return defaultOn
}

/** Read one boolean flag from the environment. Unset or unrecognised => default. */
export function isBooleanFlag(name: string, defaultOn: boolean, env: Record<string, string | undefined> = process.env): boolean {
  return parseBooleanFlagValue(env[name], defaultOn)
}

/**
 * Startup warnings for boolean flags set to unrecognised values: one line
 * per flag, naming the variable, never its value.
 */
export function booleanFlagNotices(env: Record<string, string | undefined> = process.env): string[] {
  const lines: string[] = []
  for (const flag of BOOLEAN_FLAGS) {
    const raw = (env[flag.name] ?? '').trim().toLowerCase()
    if (!raw) continue
    if ((BOOLEAN_FLAG_TRUE_VALUES as readonly string[]).includes(raw)) continue
    if ((BOOLEAN_FLAG_FALSE_VALUES as readonly string[]).includes(raw)) continue
    lines.push(
      `[hitly startup] ${flag.name} is not a recognised boolean value; using the default (${flag.defaultOn ? 'on' : 'off'}).`,
    )
  }
  return lines
}
