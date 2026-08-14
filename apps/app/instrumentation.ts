export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return
  const { registerDefaultHousekeepingJobs } = await import('./lib/housekeeping/jobs')
  const { startHousekeeping } = await import('./lib/housekeeping/scheduler')
  registerDefaultHousekeepingJobs()
  startHousekeeping()
}
