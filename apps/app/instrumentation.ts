export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return
  // Production server start check: refuse to start without a usable
  // BETTER_AUTH_SECRET (see lib/auth-secret.ts).
  const { assertProductionAuthSecret } = await import('./lib/auth-secret')
  assertProductionAuthSecret()
  const { destinationPolicyStartupNotice } = await import('@hitly/core/destination-check')
  const destinationNotice = destinationPolicyStartupNotice()
  if (destinationNotice) console.info(destinationNotice)
  const { registerDefaultHousekeepingJobs } = await import('./lib/housekeeping/jobs')
  const { startHousekeeping } = await import('./lib/housekeeping/scheduler')
  registerDefaultHousekeepingJobs()
  startHousekeeping()
}
