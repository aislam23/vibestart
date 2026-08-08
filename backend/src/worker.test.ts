import { expect, spyOn, test } from 'bun:test'

import { startWorkerLoops } from './worker'
import type { BackgroundJobName } from './jobs'
import type { BackendRuntime } from './runtime'

// The production job registry ships empty (see jobs.ts), so no real BackgroundJobName exists to
// reference here. These fixtures stand in for jobs that would exist once a product adds one; the
// tests below inject a fake `runJob` rather than depending on the real (empty) registry.
const pingJob = 'db:ping' as BackgroundJobName
const cleanupJob = 'noop' as BackgroundJobName

function countingRuntime() {
  return {} as BackendRuntime
}

test('a worker loop keeps running its job until it is stopped', async () => {
  const runtime = countingRuntime()
  const log = spyOn(console, 'log').mockImplementation(() => {})
  let pings = 0
  const runJob = async () => {
    pings += 1
  }

  try {
    const handle = startWorkerLoops(runtime, [{ job: pingJob, intervalMs: 1 }], { runJob })
    await new Promise((resolve) => setTimeout(resolve, 20))
    handle.stop()
    await handle.stopped

    // A cron cannot do this: its finest granularity is one minute.
    expect(pings).toBeGreaterThan(1)
  } finally {
    log.mockRestore()
  }
})

test('stopping wakes every sleeping loop, not just the last one', async () => {
  // A single shared waker used to leave the other loops asleep, so SIGTERM hung for a full
  // interval and the process was killed before it could close the database.
  const runtime = countingRuntime()
  const log = spyOn(console, 'log').mockImplementation(() => {})
  const runJob = async () => {}

  try {
    const handle = startWorkerLoops(
      runtime,
      [
        { job: pingJob, intervalMs: 30_000 },
        { job: cleanupJob, intervalMs: 30_000 },
      ],
      { runJob },
    )
    await new Promise((resolve) => setTimeout(resolve, 10))

    const stoppedAt = Date.now()
    handle.stop()
    await handle.stopped

    expect(Date.now() - stoppedAt).toBeLessThan(1_000)
  } finally {
    log.mockRestore()
  }
})

test('stopping does not wait out the pause between iterations', async () => {
  const runtime = countingRuntime()
  const log = spyOn(console, 'log').mockImplementation(() => {})
  const runJob = async () => {}

  try {
    const handle = startWorkerLoops(runtime, [{ job: pingJob, intervalMs: 60_000 }], { runJob })
    await new Promise((resolve) => setTimeout(resolve, 10))

    const stoppedAt = Date.now()
    handle.stop()
    await handle.stopped

    // Without waking the sleeping loop, SIGTERM would hang until the interval elapsed.
    expect(Date.now() - stoppedAt).toBeLessThan(1_000)
  } finally {
    log.mockRestore()
  }
})

test('loops run side by side and survive a failing neighbour', async () => {
  const runtime = countingRuntime()
  const log = spyOn(console, 'log').mockImplementation(() => {})
  const error = spyOn(console, 'error').mockImplementation(() => {})
  let pings = 0
  let failures = 0
  const runJob = async (jobName: string) => {
    if (jobName === cleanupJob) {
      failures += 1
      throw new Error('cleanup exploded')
    }
    pings += 1
  }

  try {
    const handle = startWorkerLoops(
      runtime,
      [
        { job: pingJob, intervalMs: 1 },
        { job: cleanupJob, intervalMs: 1 },
      ],
      { runJob },
    )
    await new Promise((resolve) => setTimeout(resolve, 20))
    handle.stop()
    await handle.stopped

    expect(pings).toBeGreaterThan(1)
    expect(failures).toBeGreaterThan(1)
    expect(error).toHaveBeenCalled()
  } finally {
    log.mockRestore()
    error.mockRestore()
  }
})

test('a single-instance loop skips its turn while another instance holds the lock', async () => {
  // Loops run unlocked by default; opting in must actually reach the database lock, otherwise
  // scaling the worker to two instances silently doubles the work.
  const calls = { transactions: 0 }
  const runtime = {
    prisma: {
      $transaction: async (run: (tx: unknown) => Promise<unknown>) => {
        calls.transactions += 1
        return run({ $queryRaw: async () => [{ acquired: false }] })
      },
    },
  } as unknown as BackendRuntime
  const log = spyOn(console, 'log').mockImplementation(() => {})
  let pings = 0
  const runJob = async () => {
    pings += 1
  }

  try {
    const handle = startWorkerLoops(
      runtime,
      [{ job: pingJob, intervalMs: 1, singleInstance: true }],
      { runJob },
    )
    await new Promise((resolve) => setTimeout(resolve, 20))
    handle.stop()
    await handle.stopped

    expect(calls.transactions).toBeGreaterThan(1)
    expect(pings).toBe(0)
    expect(log).toHaveBeenCalledWith(`Worker skipped ${pingJob}: its lock is held elsewhere.`)
  } finally {
    log.mockRestore()
  }
})

test('stopping during a running iteration does not wait out the interval that follows', async () => {
  // Without the running check between the iteration and the sleep, a stop signal that arrives
  // mid-iteration is only noticed a full interval later - long enough for a platform to SIGKILL
  // the container before it can close the database.
  const release = Promise.withResolvers<void>()
  const runtime = countingRuntime()
  const log = spyOn(console, 'log').mockImplementation(() => {})
  const runJob = async () => {
    release.resolve()
  }

  try {
    const handle = startWorkerLoops(runtime, [{ job: pingJob, intervalMs: 30_000 }], { runJob })
    await release.promise

    const stoppedAt = Date.now()
    handle.stop()
    await handle.stopped

    expect(Date.now() - stoppedAt).toBeLessThan(1_000)
  } finally {
    log.mockRestore()
  }
})
