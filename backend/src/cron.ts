import { createBackendRuntime, type BackendRuntime } from './runtime'
import { backgroundJobNames, runBackgroundJob, type JobRunOutcome } from './jobs'

/** What `runCronJob` actually needs to run a job - `runBackgroundJob`'s signature. */
type RunJob = (
  jobName: string,
  runtime: BackendRuntime,
  now?: Date,
  options?: { signal?: AbortSignal },
) => Promise<JobRunOutcome>

/** Runs one job to completion - locked by default, see `jobs.ts` - and reports whether it skipped. */
export async function runCronJob(
  runtime: BackendRuntime,
  jobName: string,
  { runJob = runBackgroundJob, signal }: { runJob?: RunJob; signal?: AbortSignal } = {},
): Promise<JobRunOutcome> {
  const outcome = await runJob(jobName, runtime, undefined, { signal })
  if (!outcome.ranHere) {
    console.log(`Cron skipped ${jobName}: its lock is held elsewhere.`)
  }
  return outcome
}

/**
 * One-shot runner: a provider timer starts the process, it runs a single job from the shared
 * registry in `jobs.ts` - locked by default, see there - and exits. Nothing runs between ticks.
 */
export async function main(argv: string[] = Bun.argv.slice(2)) {
  const [jobName] = argv

  if (!jobName) {
    console.error(`A job name is required. Available jobs: ${backgroundJobNames().join(', ') || '(none registered yet)'}`)
    process.exit(1)
  }

  const runtime = createBackendRuntime()
  const controller = new AbortController()
  const stop = (signal: string) => {
    console.log(`Cron received ${signal}; asking the job to stop.`)
    controller.abort(new Error(`process received ${signal}`))
  }
  process.on('SIGINT', () => stop('SIGINT'))
  process.on('SIGTERM', () => stop('SIGTERM'))

  try {
    await runCronJob(runtime, jobName, { signal: controller.signal })
  } finally {
    await runtime.close()
  }
}

if (import.meta.main) {
  await main()
}
