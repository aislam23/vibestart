import { Cron } from 'croner'

import { isJobLockExpiry } from './db'
import { createBackendRuntime, type BackendRuntime } from './runtime'
import { runBackgroundJob, type BackgroundJobName, type JobRunOutcome } from './jobs'

export type ScheduleEntry = {
  /** Standard cron expression; croner also accepts a leading seconds field. */
  expression: string
  job: BackgroundJobName
  /** IANA zone. Defaults to UTC so a server's local time cannot shift production schedules. */
  timeZone?: string
  /**
   * Overrides the job's own `timeoutMs` (`jobs.ts`) for how long a run from this schedule entry
   * may hold its lock. Exceeding it releases the lock mid-run and allows a duplicate on another
   * instance, so leave headroom over the slowest expected run. Ignored for a `parallel` job.
   */
  timeoutMs?: number
}

/**
 * Empty on purpose, same as `backgroundJobs` in `jobs.ts`. This process is ready but idle until a
 * product needs recurring work, so an install that never schedules anything pays nothing for it.
 *
 * Uncomment the example (or add your own) to switch it on, then run the process wherever it
 * belongs: a VPS under systemd or Docker, or a cloud worker component. See docs/BACKGROUND_JOBS.md.
 */
export const schedules: ScheduleEntry[] = [
  // { expression: '0 3 * * *', job: 'db:ping' },
]

export type ScheduledJob = { entry: ScheduleEntry; cron: Cron }

export type SchedulerHandle = {
  jobs: ScheduledJob[]
  /** Stops the timers, then resolves once every job already running has finished. */
  stop: () => Promise<void>
}

/** What `runScheduledJob` actually needs to run a job - `runBackgroundJob`'s signature. */
type RunJob = (
  jobName: string,
  runtime: BackendRuntime,
  now?: Date,
  options?: { signal?: AbortSignal; timeoutMs?: number },
) => Promise<JobRunOutcome>

/** `SHUTDOWN_GRACE_SECONDS`'s own default (env.ts) - used only when a caller does not pass
 * `shutdownGraceMs` explicitly, which `main()` below always does. */
const defaultShutdownGraceMs = 20_000

export function startSchedules(
  runtime: BackendRuntime,
  entries: ScheduleEntry[] = schedules,
  {
    runJob = runBackgroundJob,
    shutdownGraceMs = defaultShutdownGraceMs,
  }: { runJob?: RunJob; shutdownGraceMs?: number } = {},
): SchedulerHandle {
  // Per-instance rather than module scope, so two schedulers - in a test, or around a reload -
  // cannot end up draining each other's runs.
  const activeRuns = new Set<Promise<void>>()
  // Aborts every in-flight job's signal on `stop()` - see `jobs.ts`'s doc comment on `signal`. This
  // asks a job to wind down; `stop()` still only waits up to `shutdownGraceMs` for it to actually
  // finish (see below).
  const shutdownController = new AbortController()

  const jobs = entries.map((entry) => ({
    entry,
    // Deliberately unnamed: croner keeps a process-wide registry of named jobs and throws on a
    // repeat, which would take the whole scheduler down at startup the moment two entries share
    // a job - a weekday/weekend split, or the same job in two timezones.
    cron: new Cron(
      entry.expression,
      // `protect` stops a run from overlapping itself in this process; the database lock inside
      // `runBackgroundJob` (jobs.ts) stops a second process from doing the same work at the same
      // time.
      { protect: true, timezone: entry.timeZone ?? 'UTC' },
      () => {
        const run = runScheduledJob(runtime, entry, { runJob, signal: shutdownController.signal })
        activeRuns.add(run)
        return run.finally(() => activeRuns.delete(run))
      },
    ),
  }))

  return {
    jobs,
    stop: async () => {
      // Timers first so nothing new starts, then let running jobs land. Cutting a job off here
      // would leave it half-done with no success or failure recorded anywhere; aborting the
      // signal only asks it to wind down, it does not forcibly stop it - so the wait below is
      // itself bounded by `shutdownGraceMs`, or a job that ignores its signal would hang shutdown
      // forever.
      for (const { cron } of jobs) cron.stop()
      shutdownController.abort(new Error('scheduler is shutting down'))

      let timeout: ReturnType<typeof setTimeout> | undefined
      const timedOut = new Promise<false>((resolve) => {
        timeout = setTimeout(() => resolve(false), shutdownGraceMs)
      })
      const finishedInTime = await Promise.race([
        Promise.all([...activeRuns]).then(() => true as const),
        timedOut,
      ])
      if (timeout) clearTimeout(timeout)

      if (!finishedInTime) {
        console.error(
          `Scheduler shutdown grace period (${shutdownGraceMs}ms) elapsed with ${activeRuns.size} ` +
            'job(s) still running; proceeding with shutdown anyway.',
        )
      }
    },
  }
}

export async function runScheduledJob(
  runtime: BackendRuntime,
  entry: ScheduleEntry,
  { runJob = runBackgroundJob, signal }: { runJob?: RunJob; signal?: AbortSignal } = {},
) {
  try {
    const outcome = await runJob(entry.job, runtime, undefined, { signal, timeoutMs: entry.timeoutMs })

    if (!outcome.ranHere) {
      console.log(`Scheduler skipped ${entry.job}: its lock is held elsewhere.`)
    }
  } catch (error) {
    // One failing job must not take the scheduler down; the next tick tries again.
    if (isJobLockExpiry(error)) {
      console.error(
        `${error.message} Another instance may have started it too. Raise timeoutMs for this ` +
          'entry or make the job idempotent.',
        error.cause,
      )
      return
    }

    console.error(`Scheduler job ${entry.job} failed.`, error)
  }
}

export async function main() {
  const runtime = createBackendRuntime()
  const { jobs, stop: stopSchedules } = startSchedules(runtime, schedules, {
    shutdownGraceMs: runtime.env.SHUTDOWN_GRACE_SECONDS * 1000,
  })

  if (jobs.length === 0) {
    // Nothing to wait for, so do not linger as a process that a supervisor will restart forever.
    console.log(
      'Scheduler started with no schedules. Add entries to `schedules` in src/scheduler.ts; see docs/BACKGROUND_JOBS.md.',
    )
    await runtime.close()
    return
  }

  for (const { entry, cron } of jobs) {
    console.log(
      `Scheduler registered ${entry.job} (${entry.expression}); next run ${cron.nextRun()?.toISOString() ?? 'never'}.`,
    )
  }

  let stopping = false
  const stop = async (signal: string) => {
    if (stopping) return
    stopping = true
    console.log(`Scheduler received ${signal}; stopping after in-flight jobs finish.`)
    await stopSchedules()
    await runtime.close()
    process.exit(0)
  }

  process.on('SIGINT', () => void stop('SIGINT'))
  process.on('SIGTERM', () => void stop('SIGTERM'))
}

if (import.meta.main) {
  await main()
}
