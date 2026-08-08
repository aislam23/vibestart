import { isJobLockExpiry } from './db'
import { createBackendRuntime, type BackendRuntime } from './runtime'
import { runBackgroundJob, type BackgroundJobName, type JobRunOutcome } from './jobs'

export type WorkerLoop = {
  job: BackgroundJobName
  /** Pause between iterations. Use this process when a minute between runs is too long. */
  intervalMs: number
  /**
   * Overrides the job's own `timeoutMs` (`jobs.ts`) for how long an iteration of this loop may
   * hold its lock. Exceeding it releases the lock mid-run and allows a duplicate on another
   * instance, so leave headroom over the slowest expected iteration. Ignored for a `parallel` job.
   */
  timeoutMs?: number
}

/**
 * Empty on purpose, same as `backgroundJobs` in `jobs.ts` and `schedules` in `scheduler.ts`.
 *
 * The worker runs the same jobs as `cron.ts` and `scheduler.ts` - only the process shape differs.
 * A cron is a timer: it fires on a schedule, and no cron expression goes below one minute. A
 * worker is a loop: use it when work must run more often than that, must run continuously, or
 * when several jobs should run side by side. Loops listed here run in parallel with each other.
 *
 * Whether an iteration takes the advisory lock is the job's own choice (`parallel` on its
 * definition in `jobs.ts`), not this loop's - so scaling the worker to several instances is safe
 * by default without a per-loop flag to remember.
 *
 * See docs/BACKGROUND_JOBS.md before switching this on.
 */
export const workerLoops: WorkerLoop[] = [
  // { job: 'db:ping', intervalMs: 10_000 },
]

export type WorkerHandle = {
  /** Stops every loop after the iteration it is in (bounded by `shutdownGraceMs`), then resolves. */
  stop: () => Promise<void>
}

/** What `runIteration` actually needs to run a job - `runBackgroundJob`'s signature. */
type RunJob = (
  jobName: string,
  runtime: BackendRuntime,
  now?: Date,
  options?: { signal?: AbortSignal; timeoutMs?: number },
) => Promise<JobRunOutcome>

/** `SHUTDOWN_GRACE_SECONDS`'s own default (env.ts) - used only when a caller does not pass
 * `shutdownGraceMs` explicitly, which `runWorker` below always does. */
const defaultShutdownGraceMs = 20_000

export function startWorkerLoops(
  runtime: BackendRuntime,
  loops: WorkerLoop[] = workerLoops,
  {
    runJob = runBackgroundJob,
    shutdownGraceMs = defaultShutdownGraceMs,
  }: { runJob?: RunJob; shutdownGraceMs?: number } = {},
): WorkerHandle {
  let running = true
  // One waker per sleeping loop. A single shared waker would only interrupt whichever loop
  // happened to fall asleep last, so a stop signal could hang for a full interval.
  const wakers = new Set<() => void>()
  // Forwarded into every iteration - see `jobs.ts`'s doc comment on `signal`. Aborting only asks a
  // job to wind down; it does not forcibly stop it, which is why `stop()` below still bounds its
  // wait by `shutdownGraceMs` instead of trusting every job to honor the signal promptly.
  const shutdownController = new AbortController()

  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(finish, ms)
      const waker = finish
      wakers.add(waker)

      function finish() {
        clearTimeout(timer)
        wakers.delete(waker)
        resolve()
      }
    })

  async function runLoop(loop: WorkerLoop) {
    while (running) {
      try {
        await runIteration(runtime, loop, runJob, shutdownController.signal)
      } catch (error) {
        // A failing iteration must not kill the loop; the next one tries again after the
        // usual pause.
        reportIterationFailure(loop, error)
      }

      if (!running) break
      await sleep(loop.intervalMs)
    }
  }

  const allStopped = Promise.all(loops.map(runLoop)).then(() => undefined)

  return {
    stop: async () => {
      running = false
      shutdownController.abort(new Error('worker is shutting down'))
      for (const wake of [...wakers]) wake()

      let timeout: ReturnType<typeof setTimeout> | undefined
      const timedOut = new Promise<false>((resolve) => {
        timeout = setTimeout(() => resolve(false), shutdownGraceMs)
      })
      const finishedInTime = await Promise.race([allStopped.then(() => true as const), timedOut])
      if (timeout) clearTimeout(timeout)

      if (!finishedInTime) {
        console.error(
          `Worker shutdown grace period (${shutdownGraceMs}ms) elapsed with a loop still running; ` +
            'proceeding with shutdown anyway.',
        )
      }
    },
  }
}

async function runIteration(runtime: BackendRuntime, loop: WorkerLoop, runJob: RunJob, signal: AbortSignal) {
  const outcome = await runJob(loop.job, runtime, undefined, { signal, timeoutMs: loop.timeoutMs })

  if (!outcome.ranHere) {
    console.log(`Worker skipped ${loop.job}: its lock is held elsewhere.`)
  }
}

function reportIterationFailure(loop: WorkerLoop, error: unknown) {
  if (isJobLockExpiry(error)) {
    console.error(
      `${error.message} Another instance may have started it too. Raise timeoutMs for this loop ` +
        'or make the job idempotent.',
      error.cause,
    )
    return
  }

  console.error(`Worker job ${loop.job} failed.`, error)
}

export async function runWorker(runtime: BackendRuntime) {
  if (workerLoops.length === 0) {
    console.log(
      'Worker started with no loops. Add entries to `workerLoops` in src/worker.ts; see docs/BACKGROUND_JOBS.md.',
    )
    return
  }

  const handle = startWorkerLoops(runtime, workerLoops, {
    shutdownGraceMs: runtime.env.SHUTDOWN_GRACE_SECONDS * 1000,
  })
  const stopped = Promise.withResolvers<void>()
  let stopping = false

  const stop = (signal: string) => {
    if (stopping) return
    stopping = true
    console.log(`Worker received ${signal}; finishing the current iteration.`)
    void handle.stop().then(stopped.resolve)
  }

  process.on('SIGINT', () => stop('SIGINT'))
  process.on('SIGTERM', () => stop('SIGTERM'))

  await stopped.promise
}

export async function main() {
  const runtime = createBackendRuntime()

  try {
    await runWorker(runtime)
  } finally {
    await runtime.close()
  }
}

if (import.meta.main) {
  await main()
}
