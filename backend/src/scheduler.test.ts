import { expect, spyOn, test } from 'bun:test'

import { runScheduledJob, startSchedules, type ScheduleEntry } from './scheduler'
import type { BackgroundJobName, JobRunOutcome } from './jobs'
import type { BackendRuntime } from './runtime'

function fakeRuntime() {
  return {} as BackendRuntime
}

// The production job registry ships empty (see jobs.ts), so no real BackgroundJobName exists to
// reference here. These fixtures stand in for a job that would exist once a product adds one; the
// tests below inject a fake `runJob` rather than depending on the real (empty) registry. Locking
// is `jobs.ts`'s responsibility now (see jobs.test.ts and cron.test.ts for that mechanism) -
// `runJob` here already returns the locked-or-skipped outcome, the same as `runBackgroundJob` does.
const pingJob = 'db:ping' as BackgroundJobName
const pingEntry: ScheduleEntry = { expression: '* * * * *', job: pingJob }

test('a scheduled job runs when runJob reports it ran', async () => {
  const runtime = fakeRuntime()
  const jobCalls: string[] = []
  const runJob = async (jobName: string): Promise<JobRunOutcome> => {
    jobCalls.push(jobName)
    return { ranHere: true }
  }

  await runScheduledJob(runtime, pingEntry, { runJob })

  expect(jobCalls).toEqual([pingJob])
})

test('a scheduled job is skipped while another process holds the lock', async () => {
  // Two copies of the scheduler are normal during a rolling deploy; the second must do nothing
  // rather than run the same job twice.
  const runtime = fakeRuntime()
  const log = spyOn(console, 'log').mockImplementation(() => {})
  const jobCalls: string[] = []
  const runJob = async (jobName: string): Promise<JobRunOutcome> => {
    jobCalls.push(jobName)
    return { ranHere: false }
  }

  try {
    await runScheduledJob(runtime, pingEntry, { runJob })

    expect(log).toHaveBeenCalledWith(`Scheduler skipped ${pingJob}: its lock is held elsewhere.`)
    expect(jobCalls).toEqual([pingJob])
  } finally {
    log.mockRestore()
  }
})

test('a failing job is reported and does not escape the scheduler', async () => {
  const runtime = fakeRuntime()
  const runJob = async (): Promise<JobRunOutcome> => {
    throw new Error('database is unreachable')
  }
  const error = spyOn(console, 'error').mockImplementation(() => {})

  try {
    // No rejection: the next tick must still happen.
    await runScheduledJob(runtime, pingEntry, { runJob })

    expect(error).toHaveBeenCalled()
    expect(String(error.mock.calls[0]?.[0])).toContain(pingJob)
  } finally {
    error.mockRestore()
  }
})

test('forwards the entry timeoutMs and an external signal through to runJob', async () => {
  const runtime = fakeRuntime()
  const controller = new AbortController()
  const calls: unknown[] = []
  const runJob = async (
    jobName: string,
    _rt: BackendRuntime,
    _now?: Date,
    options?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<JobRunOutcome> => {
    calls.push([jobName, options?.signal, options?.timeoutMs])
    return { ranHere: true }
  }

  await runScheduledJob(runtime, { ...pingEntry, timeoutMs: 1_234 }, { runJob, signal: controller.signal })

  expect(calls).toEqual([[pingJob, controller.signal, 1_234]])
})

test('schedules default to UTC so a server timezone cannot move production runs', () => {
  const runtime = fakeRuntime()
  const { jobs } = startSchedules(runtime, [
    { expression: '0 3 * * *', job: pingJob },
    { expression: '0 3 * * *', job: pingJob, timeZone: 'Europe/Moscow' },
  ])
  const [utc, explicit] = jobs.map((job) => job.cron)

  try {
    expect(utc?.options.timezone).toBe('UTC')
    expect(explicit?.options.timezone).toBe('Europe/Moscow')
    // Same wall-clock expression, different zones, so the next runs cannot coincide.
    expect(utc?.nextRun()?.getTime()).not.toBe(explicit?.nextRun()?.getTime())
  } finally {
    utc?.stop()
    explicit?.stop()
  }
})

test('a job that outran its lock is reported as a duplicate-run risk, not a generic failure', async () => {
  const runtime = fakeRuntime()
  const runJob = async (): Promise<JobRunOutcome> => {
    // `db.ts`'s own tests cover the classification logic; here we only need `runScheduledJob` to
    // recognize and specially log a `JobLockExpiredError` it receives from `runJob`.
    const { JobLockExpiredError } = await import('./db')
    throw new JobLockExpiredError(pingJob, 10, 15, new Error('transaction expired'))
  }
  const error = spyOn(console, 'error').mockImplementation(() => {})

  try {
    await runScheduledJob(runtime, { ...pingEntry, timeoutMs: 10 }, { runJob })

    expect(String(error.mock.calls[0]?.[0])).toContain('past its 10ms lock')
    expect(String(error.mock.calls[0]?.[0])).toContain('Another instance may have started it too')
  } finally {
    error.mockRestore()
  }
})

test('shutdown waits for a job that is already running, up to its grace period', async () => {
  // Stopping the timers is not enough: cutting a running job off would leave it half-done with
  // neither a success nor a failure recorded anywhere.
  const release = Promise.withResolvers<void>()
  let finished = false
  const runtime = fakeRuntime()
  const runJob = async (): Promise<JobRunOutcome> => {
    await release.promise
    finished = true
    return { ranHere: true }
  }
  const log = spyOn(console, 'log').mockImplementation(() => {})

  try {
    // Every second, so the tick lands inside the test rather than at the top of a minute. A
    // generous grace period so this test's own release, not the timeout, is what unblocks stop().
    const handle = startSchedules(
      runtime,
      [{ expression: '* * * * * *', job: pingJob }],
      { runJob, shutdownGraceMs: 5_000 },
    )
    await Bun.sleep(1_100)

    let drained = false
    const drain = handle.stop().then(() => {
      drained = true
    })

    await Bun.sleep(50)
    expect({ drained, finished }).toEqual({ drained: false, finished: false })

    release.resolve()
    await drain
    expect({ drained, finished }).toEqual({ drained: true, finished: true })
  } finally {
    log.mockRestore()
  }
})

test('shutdown gives up after its grace period even if the job never finishes', async () => {
  const runtime = fakeRuntime()
  const runJob = async (): Promise<JobRunOutcome> => {
    await new Promise(() => undefined) // never resolves; simulates a job that ignores its signal.
    return { ranHere: true }
  }
  const log = spyOn(console, 'log').mockImplementation(() => {})
  const error = spyOn(console, 'error').mockImplementation(() => {})

  try {
    const handle = startSchedules(
      runtime,
      [{ expression: '* * * * * *', job: pingJob }],
      { runJob, shutdownGraceMs: 100 },
    )
    await Bun.sleep(1_100)

    const startedAt = Date.now()
    await handle.stop()
    const elapsedMs = Date.now() - startedAt

    expect(elapsedMs).toBeLessThan(1_000)
    expect(error).toHaveBeenCalled()
    expect(String(error.mock.calls.at(-1)?.[0])).toContain('grace period')
  } finally {
    log.mockRestore()
    error.mockRestore()
  }
})

test('one job can be scheduled more than once', () => {
  // A weekday/weekend split, or the same job in two timezones. croner throws on a repeated job
  // name, and that throw would happen at startup, before any signal handler exists - a supervised
  // process would then restart-loop with every schedule dead.
  const runtime = fakeRuntime()

  const handle = startSchedules(runtime, [
    { expression: '0 9 * * 1-5', job: pingJob },
    { expression: '0 12 * * 6,0', job: pingJob },
  ])

  try {
    expect(handle.jobs.map((job) => job.cron.nextRun()?.getTime())).not.toContain(undefined)
    expect(handle.jobs).toHaveLength(2)
  } finally {
    void handle.stop()
  }
})
