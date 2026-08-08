import { expect, spyOn, test } from 'bun:test'

import { runCronJob } from './cron'
import { createBackgroundJobRegistry } from './jobs'
import type { BackendRuntime } from './runtime'

function runtimeWithSharedLock() {
  // Shared, process-wide-looking lock state, standing in for the Postgres advisory lock two real
  // `cron.ts` invocations (e.g. an overlapping provider timer) would contend for.
  let locked = false
  const prisma = {
    $transaction: async (run: (tx: unknown) => Promise<unknown>) =>
      run({
        $queryRaw: async () => {
          if (locked) return [{ acquired: false }]
          locked = true
          return [{ acquired: true }]
        },
      }),
  }
  return { prisma } as unknown as BackendRuntime
}

test('two concurrent cron invocations of the same job: one runs, one skips', async () => {
  // Unlike scheduler.ts/worker.ts, cron.ts had no locking at all before this job registry took it
  // over by default - two overlapping provider-timer triggers of the same job used to both run.
  const runtime = runtimeWithSharedLock()
  const log = spyOn(console, 'log').mockImplementation(() => {})
  let runs = 0
  const { run } = createBackgroundJobRegistry({
    job: async () => {
      runs += 1
    },
  })

  try {
    const [first, second] = await Promise.all([
      runCronJob(runtime, 'job', { runJob: run }),
      runCronJob(runtime, 'job', { runJob: run }),
    ])

    expect(runs).toBe(1)
    expect([first.ranHere, second.ranHere].sort()).toEqual([false, true])
    expect(log).toHaveBeenCalledWith('Cron skipped job: its lock is held elsewhere.')
  } finally {
    log.mockRestore()
  }
})

test('logs and reports skipped when runJob reports its lock is held elsewhere', async () => {
  // `runJob` stands in for `runBackgroundJob` (== the locked registry entry point, see
  // jobs.test.ts): a `{ ranHere: false }` outcome already means the underlying job body never
  // ran - `runCronJob` only needs to interpret and log that outcome correctly.
  const runtime = {} as BackendRuntime
  const log = spyOn(console, 'log').mockImplementation(() => {})
  const runJob = async () => ({ ranHere: false as const })

  try {
    const outcome = await runCronJob(runtime, 'job', { runJob })

    expect(outcome).toEqual({ ranHere: false })
    expect(log).toHaveBeenCalledWith('Cron skipped job: its lock is held elsewhere.')
  } finally {
    log.mockRestore()
  }
})

test('runs the job and reports ranHere when nothing else holds the lock', async () => {
  const runtime = {} as BackendRuntime
  const log = spyOn(console, 'log').mockImplementation(() => {})
  const calls: string[] = []
  const runJob = async (jobName: string) => {
    calls.push(jobName)
    return { ranHere: true as const }
  }

  try {
    const outcome = await runCronJob(runtime, 'job', { runJob })

    expect(outcome).toEqual({ ranHere: true })
    expect(calls).toEqual(['job'])
    expect(log).not.toHaveBeenCalled()
  } finally {
    log.mockRestore()
  }
})

test('forwards the caller signal through to runJob', async () => {
  const runtime = {} as BackendRuntime
  const controller = new AbortController()
  let observedSignal: AbortSignal | undefined
  const runJob = async (_jobName: string, _rt: BackendRuntime, _now?: Date, options?: { signal?: AbortSignal }) => {
    observedSignal = options?.signal
    return { ranHere: true as const }
  }

  await runCronJob(runtime, 'job', { runJob, signal: controller.signal })

  expect(observedSignal).toBe(controller.signal)
})
