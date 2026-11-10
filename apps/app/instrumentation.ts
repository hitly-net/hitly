export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return
  // Server start checks (see lib/startup-checks.ts): in production, refuse to
  // start without a usable BETTER_AUTH_SECRET or with a development database
  // password; in every environment, refuse a malformed HITLY_TRUSTED_PROXIES,
  // a bad HITLY_DB_CONNECTION_TIMEOUT_MS, or HITLY_DB_POOL_MAX below 3.
  // The process exits with a message that names the variable, never its value.
  const { exitOnStartupProblems, logStartupNotices } = await import('./lib/startup-checks')
  exitOnStartupProblems()
  logStartupNotices()
  const { destinationPolicyStartupNotice } = await import('@hitly/core/destination-check')
  const destinationNotice = destinationPolicyStartupNotice()
  if (destinationNotice) console.info(destinationNotice)
  const { registerDefaultHousekeepingJobs } = await import('./lib/housekeeping/jobs')
  const { startHousekeeping } = await import('./lib/housekeeping/scheduler')
  registerDefaultHousekeepingJobs()
  startHousekeeping()
}
