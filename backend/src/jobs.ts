import type { BackendRuntime } from './runtime'

export type BackgroundJob = (runtime: BackendRuntime, now: Date) => Promise<void>

/**
 * The mechanism behind `backgroundJobs` below: given any registry of jobs, returns the three
 * operations every runner needs (list the names, recognize a name, run a job by name). Generic so
 * `jobs.test.ts` can exercise the mechanism end-to-end - register a job, run it, list it, reject an
 * unknown or inherited name - against a small fixture registry, without adding a real job to the
 * empty production registry just to make that possible.
 */
export function createBackgroundJobRegistry<Registry extends Record<string, BackgroundJob>>(
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

  async function run(jobName: string, runtime: BackendRuntime, now = new Date()) {
    if (!isName(jobName)) {
      const available = names().join(', ') || '(none registered yet)'
      throw new Error(`Unknown job "${jobName}". Available jobs: ${available}`)
    }

    await registry[jobName](runtime, now)
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
 * **Ships empty on purpose**, like `schedules` in `scheduler.ts` and `workerLoops` in `worker.ts`:
 * this template has no session table to sweep (Supabase Auth owns sessions) and no other
 * recurring work yet, so an install that never needs one pays nothing for it. Uncomment the
 * example (or add your own) the day a real job exists.
 */
export const backgroundJobs = {
  // 'db:ping': async ({ prisma }) => {
  //   await prisma.$queryRaw`SELECT 1`
  //   console.log('Job db:ping completed.')
  // },
} satisfies Record<string, BackgroundJob>

export type BackgroundJobName = keyof typeof backgroundJobs

const registry = createBackgroundJobRegistry(backgroundJobs)

export const backgroundJobNames = registry.names
export const isBackgroundJobName = registry.isName
export const runBackgroundJob = registry.run
