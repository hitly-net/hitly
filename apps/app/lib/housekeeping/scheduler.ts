import { and, eq, isNull } from 'drizzle-orm'
import type { HousekeepingSchedule } from '@hitly/core'
import { housekeepingJobs } from '@hitly/db/schema'
import { requireDb } from '../require-db'
import { affectedRows } from './result'

const INTERVAL_MS: Record<HousekeepingSchedule, number> = {
  hourly: 60 * 60 * 1000,
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
}

const STALE_LOCK_MS = 30 * 60 * 1000

export type HousekeepingJob = {
  id: string
  schedule: HousekeepingSchedule
  run: () => Promise<Record<string, unknown> | void>
}

export type HousekeepingRunResult = {
  id: string
  schedule: HousekeepingSchedule
  skipped?: 'not_due' | 'locked'
  result?: Record<string, unknown>
  error?: string
}

const registry: HousekeepingJob[] = []
let timer: ReturnType<typeof setInterval> | null = null
let runningTick = false

export function registerHousekeepingJob(job: HousekeepingJob) {
  const index = registry.findIndex((item) => item.id === job.id)
  if (index >= 0) {
    registry[index] = job
    return
  }
  registry.push(job)
}

export function listHousekeepingJobs() {
  return registry.map((job) => ({ id: job.id, schedule: job.schedule }))
}

function isDue(lastFinishedAt: Date | null, schedule: HousekeepingSchedule, now: Date) {
  if (!lastFinishedAt) return true
  return now.getTime() - lastFinishedAt.getTime() >= INTERVAL_MS[schedule]
}

function isLocked(row: { lastStartedAt: Date | null; lastFinishedAt: Date | null }, now: Date) {
  if (!row.lastStartedAt) return false
  const started = row.lastStartedAt.getTime()
  const finished = row.lastFinishedAt?.getTime() ?? 0
  if (finished >= started) return false
  return now.getTime() - started < STALE_LOCK_MS
}

async function claimJob(job: HousekeepingJob, now: Date, force: boolean) {
  const database = requireDb()
  const existing = await database.select().from(housekeepingJobs).where(eq(housekeepingJobs.id, job.id)).limit(1)
  const row = existing[0]

  if (!row) {
    await database.insert(housekeepingJobs).values({
      id: job.id,
      schedule: job.schedule,
      lastStartedAt: now,
    })
    return true
  }
  if (isLocked(row, now)) return false
  if (!force && !isDue(row.lastFinishedAt, job.schedule, now)) return false

  const claimed = await database
    .update(housekeepingJobs)
    .set({ lastStartedAt: now, lastError: null })
    .where(
      and(
        eq(housekeepingJobs.id, job.id),
        row.lastStartedAt
          ? eq(housekeepingJobs.lastStartedAt, row.lastStartedAt)
          : isNull(housekeepingJobs.lastStartedAt),
      ),
    )
  return affectedRows(claimed) > 0
}

async function finishJob(id: string, now: Date, result: Record<string, unknown> | null, error: string | null) {
  const database = requireDb()
  await database
    .update(housekeepingJobs)
    .set({
      lastFinishedAt: now,
      lastResult: result,
      lastError: error,
    })
    .where(eq(housekeepingJobs.id, id))
}

async function runJob(job: HousekeepingJob, force: boolean): Promise<HousekeepingRunResult> {
  const now = new Date()
  const claimed = await claimJob(job, now, force)
  if (!claimed) {
    const database = requireDb()
    const existing = await database.select().from(housekeepingJobs).where(eq(housekeepingJobs.id, job.id)).limit(1)
    const row = existing[0]
    return {
      id: job.id,
      schedule: job.schedule,
      skipped: row && isLocked(row, now) ? 'locked' : 'not_due',
    }
  }

  try {
    const result = (await job.run()) ?? {}
    await finishJob(job.id, new Date(), result, null)
    return { id: job.id, schedule: job.schedule, result }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Housekeeping job failed'
    await finishJob(job.id, new Date(), null, message)
    return { id: job.id, schedule: job.schedule, error: message }
  }
}

export async function runDueHousekeeping(args?: { job?: string; force?: boolean }) {
  const selected = args?.job ? registry.filter((job) => job.id === args.job) : registry
  if (args?.job && selected.length === 0) {
    throw new Error(`Unknown housekeeping job "${args.job}"`)
  }
  const runs: HousekeepingRunResult[] = []
  for (const job of selected) {
    runs.push(await runJob(job, Boolean(args?.force)))
  }
  return runs
}

export function startHousekeeping(options?: { tickMs?: number }) {
  if (timer) return
  if (process.env.HITLY_HOUSEKEEPING === '0') return
  if (process.env.NEXT_PHASE === 'phase-production-build') return

  const tickMs = options?.tickMs ?? 60_000
  const tick = () => {
    if (runningTick) return
    runningTick = true
    void runDueHousekeeping()
      .catch((error) => {
        console.error('[hitly housekeeping]', error)
      })
      .finally(() => {
        runningTick = false
      })
  }

  timer = setInterval(tick, tickMs)
  timer.unref?.()
  setTimeout(tick, 5_000).unref?.()
}

export function stopHousekeeping() {
  if (!timer) return
  clearInterval(timer)
  timer = null
}
