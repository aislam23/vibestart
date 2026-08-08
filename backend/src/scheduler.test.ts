import { expect, spyOn, test } from 'bun:test'

import { runScheduledJob, startSchedules, type ScheduleEntry } from './scheduler'
import type { BackgroundJobName } from './jobs'
import type { BackendRuntime } from './runtime'

function runtimeWithLock(options: { acquired: boolean }) {
  const calls = { transactions: 0 }

  const prisma = {
    $transaction: async (run: (tx: unknown) => Promise<unknown>) => {
      calls.transactions += 1
      return run({
        $queryRaw: async () => [{ acquired: options.acquired }],
      })
    },
    $queryRaw: async () => [{ '?column?': 1 }],
  }

  return { calls, runtime: { prisma } as unknown as BackendRuntime }
}

// The production job registry ships empty (see jobs.ts), so no real BackgroundJobName exists to
// reference here. These fixtures stand in for a job that would exist once a product adds one; the
// tests below inject a fake `runJob` rather than depending on the real (empty) registry.
const pingJob = 'db:ping' as BackgroundJobName
const pingEntry: ScheduleEntry = { expression: '* * * * *', job: pingJob }

test('a scheduled job runs when this process wins the lock', async () => {
  const { calls, runtime } = runtimeWithLock({ acquired: true })
  const jobCalls: string[] = []
  const runJob = async (jobName: string) => {
    jobCalls.push(jobName)
  }

  await runScheduledJob(runtime, pingEntry, { runJob })

  expect(calls.transactions).toBe(1)
  expect(jobCalls).toEqual([pingJob])
})

test('a scheduled job is skipped while another process holds the lock', async () => {
  // Two copies of the scheduler are normal during a rolling deploy; the second must do nothing
  // rather than run the same job twice.
  const { runtime } = runtimeWithLock({ acquired: false })
  const log = spyOn(console, 'log').mockImplementation(() => {})
  const jobCalls: string[] = []
  const runJob = async (jobName: string) => {
    jobCalls.push(jobName)
  }

  try {
    await runScheduledJob(runtime, pingEntry, { runJob })

    expect(log).toHaveBeenCalledWith(`Scheduler skipped ${pingJob}: its lock is held elsewhere.`)
    expect(jobCalls).toEqual([])
  } finally {
    log.mockRestore()
  }
})

test('a failing job is reported and does not escape the scheduler', async () => {
  const runtime = {
    prisma: {
      $transaction: async () => {
        throw new Error('database is unreachable')
      },
    },
  } as unknown as BackendRuntime
  const error = spyOn(console, 'error').mockImplementation(() => {})

  try {
    // No rejection: the next tick must still happen.
    await runScheduledJob(runtime, pingEntry)

    expect(error).toHaveBeenCalled()
    expect(String(error.mock.calls[0]?.[0])).toContain(pingJob)
  } finally {
    error.mockRestore()
  }
})

test('schedules default to UTC so a server timezone cannot move production runs', () => {
  const { runtime } = runtimeWithLock({ acquired: true })
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
  // Prisma answers the same P2028 when the connection pool is saturated: it gives up before the
  // transaction, and therefore before the lock, exists. Counting that wait as lock time told the
  // operator to raise a timeout and warned about a duplicate run that could not have happened.
  const runtime = {
    prisma: {
      // The transaction starts and the job runs; the commit is what fails, after the budget.
      $transaction: async (run: (tx: unknown) => Promise<unknown>) => {
        await run({ $queryRaw: async () => [{ acquired: true }] })
        await Bun.sleep(30)
        throw Object.assign(new Error('transaction expired'), { code: 'P2028' })
      },
      $queryRaw: async () => [{ '?column?': 1 }],
    },
  } as unknown as BackendRuntime
  const error = spyOn(console, 'error').mockImplementation(() => {})
  const log = spyOn(console, 'log').mockImplementation(() => {})
  const runJob = async () => {}

  try {
    await runScheduledJob(runtime, { ...pingEntry, timeoutMs: 10 }, { runJob })

    expect(String(error.mock.calls[0]?.[0])).toContain('past its 10ms lock')
    expect(String(error.mock.calls[0]?.[0])).toContain('Another instance may have started it too')
  } finally {
    error.mockRestore()
    log.mockRestore()
  }
})

test('a transaction failure inside a job is not blamed on the lock', async () => {
  // The same P2028 arrives when the job runs its own nested transaction and that one times out.
  // Telling the operator to raise the lock timeout would send them after the wrong thing.
  const runtime = {
    prisma: {
      $transaction: async () => {
        throw Object.assign(new Error('inner transaction expired'), { code: 'P2028' })
      },
    },
  } as unknown as BackendRuntime
  const error = spyOn(console, 'error').mockImplementation(() => {})

  try {
    await runScheduledJob(runtime, { ...pingEntry, timeoutMs: 60_000 })

    expect(String(error.mock.calls[0]?.[0])).toBe(`Scheduler job ${pingJob} failed.`)
  } finally {
    error.mockRestore()
  }
})

test('shutdown waits for a job that is already running', async () => {
  // Stopping the timers is not enough: cutting a running job off would leave it half-done with
  // neither a success nor a failure recorded anywhere.
  const release = Promise.withResolvers<void>()
  let finished = false
  const { runtime } = runtimeWithLock({ acquired: true })
  const runJob = async () => {
    await release.promise
    finished = true
  }
  const log = spyOn(console, 'log').mockImplementation(() => {})

  try {
    // Every second, so the tick lands inside the test rather than at the top of a minute.
    const handle = startSchedules(
      runtime,
      [{ expression: '* * * * * *', job: pingJob }],
      { runJob },
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

test('one job can be scheduled more than once', () => {
  // A weekday/weekend split, or the same job in two timezones. croner throws on a repeated job
  // name, and that throw would happen at startup, before any signal handler exists - a supervised
  // process would then restart-loop with every schedule dead.
  const { runtime } = runtimeWithLock({ acquired: true })

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
