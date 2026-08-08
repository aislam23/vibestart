import { defaultJobLockTimeoutMs, runWithJobLock } from './db'
import type { BackendRuntime } from './runtime'

export type BackgroundJob = (runtime: BackendRuntime, now: Date, signal: AbortSignal) => Promise<void>

export type BackgroundJobDefinition = {
  run: BackgroundJob
  /**
   * Opts a job out of the default advisory-lock serialization (`runWithJobLock`, src/db.ts). Off
   * by default: locking is the safe default for every runner (cron, scheduler, worker), so a job
   * only runs unlocked when it is demonstrably safe to run more than once at a time - e.g. already
   * idempotent, or serialized by something else. Set `parallel: true` to opt out.
   */
  parallel?: boolean
  /** How long this job may hold its lock. Defaults to `defaultJobLockTimeoutMs`. Ignored when `parallel`. */
  timeoutMs?: number
}

type BackgroundJobEntry = BackgroundJob | BackgroundJobDefinition

export type JobRunOutcome = { ranHere: true } | { ranHere: false }

type RunOptions = {
  /** Aborts the job's signal - e.g. on process shutdown. Forwarded alongside the runner's own
   * lock/timeout-expiry abort; either can fire the signal the job receives. */
  signal?: AbortSignal
  /** Overrides the job definition's own `timeoutMs` for this one invocation. */
  timeoutMs?: number
}

function normalizeJobEntry(entry: BackgroundJobEntry): BackgroundJobDefinition {
  if (typeof entry === 'function') return { run: entry }
  return entry
}

function forwardAbort(parentSignal: AbortSignal, controller: AbortController) {
  if (parentSignal.aborted) {
    controller.abort(parentSignal.reason)
    return
  }
  parentSignal.addEventListener('abort', () => controller.abort(parentSignal.reason), { once: true })
}

/**
 * The mechanism behind `backgroundJobs` below: given any registry of jobs, returns the three
 * operations every runner needs (list the names, recognize a name, run a job by name). Generic so
 * `jobs.test.ts` can exercise the mechanism end-to-end - register a job, run it, list it, reject an
 * unknown or inherited name - against a small fixture registry, without adding a real job to the
 * empty production registry just to make that possible.
 *
 * **Locking lives here, not in the runners.** `cron.ts`, `scheduler.ts`, and `worker.ts` all call
 * `run()` and get the same default advisory-lock serialization (`runWithJobLock`) whether they are
 * a one-shot process, an in-process timer, or a loop - none of them has to remember to lock, and
 * none of them can accidentally skip it. A job opts out with `parallel: true` on its own
 * definition, once, rather than every runner having to be told separately.
 */
export function createBackgroundJobRegistry<Registry extends Record<string, BackgroundJobEntry>>(
  registry: Registry,
) {
  type Name = keyof Registry & string

  function names(): Name[] {
    return Object.keys(registry) as Name[]
  }

  function isName(value: string): value is Name {
    // `value in registry` would also accept 'constructor', 'toString' and the rest of
    // Object.prototype, and those would then run nothing and exit 0 - a provider timer would
    // report a healthy job every night while doing no work.
    return Object.hasOwn(registry, value)
  }

  async function run(
    jobName: string,
    runtime: BackendRuntime,
    now = new Date(),
    { signal: parentSignal, timeoutMs: timeoutOverrideMs }: RunOptions = {},
  ): Promise<JobRunOutcome> {
    if (!isName(jobName)) {
      const available = names().join(', ') || '(none registered yet)'
      throw new Error(`Unknown job "${jobName}". Available jobs: ${available}`)
    }

    const definition = normalizeJobEntry(registry[jobName])

    if (definition.parallel) {
      const controller = new AbortController()
      if (parentSignal) forwardAbort(parentSignal, controller)
      await definition.run(runtime, now, controller.signal)
      return { ranHere: true }
    }

    return runWithJobLock(runtime.prisma, jobName, (signal) => definition.run(runtime, now, signal), {
      timeoutMs: timeoutOverrideMs ?? definition.timeoutMs ?? defaultJobLockTimeoutMs,
      signal: parentSignal,
    })
  }

  return { names, isName, run }
}

/**
 * The one place a background job is declared.
 *
 * Jobs, not tasks: `background-tasks.ts` next door is a different mechanism - it defers
 * best-effort work inside a single API request. These run outside any request.
 *
 * **Keep every import in this file a type import.** Tooling outside the backend reads this list
 * without a database, and may run before `prisma:generate` has; a runtime import here would drag
 * the Prisma client and the env schema along. Reach for `runtime` inside a job body instead of
 * importing a service at the top.
 *
 * Jobs say what to do; they never say when or where. Three processes run this same registry:
 *   - `cron.ts`      - one shot, triggered by a provider timer (DigitalOcean job, Yandex trigger, system cron)
 *   - `scheduler.ts` - a timer inside a long-running process, for a VPS or a cloud worker
 *   - `worker.ts`    - a loop, for work that must run more often than once a minute or in parallel
 *
 * Adding a job here makes it available to all three. See docs/BACKGROUND_JOBS.md.
 *
 * A job is either a plain `(runtime, now, signal) => Promise<void>` function (locked by default),
 * or a `{ run, parallel?, timeoutMs? }` definition when it needs to opt out of locking or override
 * its lock's timeout. `signal` aborts when this job's lock/transaction times out mid-run and when
 * the runner is shutting down - a job should check it (or pass it to whatever it awaits) and stop;
 * it is cooperative, not forcible.
 *
 * **Ships empty on purpose**, like `schedules` in `scheduler.ts` and `workerLoops` in `worker.ts`:
 * this template has no session table to sweep (Supabase Auth owns sessions) and no other
 * recurring work yet, so an install that never needs one pays nothing for it. Uncomment the
 * example (or add your own) the day a real job exists.
 */
export const backgroundJobs = {
  // 'db:ping': async ({ prisma }, now, signal) => {
  //   await prisma.$queryRaw`SELECT 1`
  //   console.log('Job db:ping completed.')
  // },
  // A job safe to run more than once at a time (idempotent, or serialized elsewhere) opts out of
  // the default lock:
  // 'cache:warm': { run: async ({ prisma }) => { ... }, parallel: true },
} satisfies Record<string, BackgroundJobEntry>

export type BackgroundJobName = keyof typeof backgroundJobs

const registry = createBackgroundJobRegistry(backgroundJobs)

export const backgroundJobNames = registry.names
export const isBackgroundJobName = registry.isName
export const runBackgroundJob = registry.run
