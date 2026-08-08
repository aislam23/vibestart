import { expect, spyOn, test } from 'bun:test'

import { startWorkerLoops } from './worker'
import type { BackgroundJobName, JobRunOutcome } from './jobs'
import type { BackendRuntime } from './runtime'

// The production job registry ships empty (see jobs.ts), so no real BackgroundJobName exists to
// reference here. These fixtures stand in for jobs that would exist once a product adds one; the
// tests below inject a fake `runJob` rather than depending on the real (empty) registry. Whether an
// iteration locks is `jobs.ts`'s responsibility now (see jobs.test.ts) - `runJob` here already
// returns the locked-or-skipped outcome, the same as `runBackgroundJob` does.
const pingJob = 'db:ping' as BackgroundJobName
const cleanupJob = 'noop' as BackgroundJobName

function countingRuntime() {
  return {} as BackendRuntime
}

test('a worker loop keeps running its job until it is stopped', async () => {
  const runtime = countingRuntime()
  const log = spyOn(console, 'log').mockImplementation(() => {})
  let pings = 0
  const runJob = async (): Promise<JobRunOutcome> => {
    pings += 1
    return { ranHere: true }
  }

  try {
    const handle = startWorkerLoops(runtime, [{ job: pingJob, intervalMs: 1 }], { runJob })
    await new Promise((resolve) => setTimeout(resolve, 20))
    await handle.stop()

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
  const runJob = async (): Promise<JobRunOutcome> => ({ ranHere: true })

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
    await handle.stop()

    expect(Date.now() - stoppedAt).toBeLessThan(1_000)
  } finally {
    log.mockRestore()
  }
})

test('stopping does not wait out the pause between iterations', async () => {
  const runtime = countingRuntime()
  const log = spyOn(console, 'log').mockImplementation(() => {})
  const runJob = async (): Promise<JobRunOutcome> => ({ ranHere: true })

  try {
    const handle = startWorkerLoops(runtime, [{ job: pingJob, intervalMs: 60_000 }], { runJob })
    await new Promise((resolve) => setTimeout(resolve, 10))

    const stoppedAt = Date.now()
    await handle.stop()

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
  const runJob = async (jobName: string): Promise<JobRunOutcome> => {
    if (jobName === cleanupJob) {
      failures += 1
      throw new Error('cleanup exploded')
    }
    pings += 1
    return { ranHere: true }
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
    await handle.stop()

    expect(pings).toBeGreaterThan(1)
    expect(failures).toBeGreaterThan(1)
    expect(error).toHaveBeenCalled()
  } finally {
    log.mockRestore()
    error.mockRestore()
  }
})

test('logs and does not count a skipped iteration when runJob reports its lock is held elsewhere', async () => {
  // Locking itself is exercised in jobs.test.ts and cron.test.ts; here we only need the worker to
  // correctly interpret and log the outcome `runJob` (== `runBackgroundJob` in production) reports.
  const runtime = countingRuntime()
  const log = spyOn(console, 'log').mockImplementation(() => {})
  let pings = 0
  const runJob = async (): Promise<JobRunOutcome> => {
    pings += 1
    return { ranHere: false }
  }

  try {
    const handle = startWorkerLoops(runtime, [{ job: pingJob, intervalMs: 1 }], { runJob })
    await new Promise((resolve) => setTimeout(resolve, 20))
    await handle.stop()

    expect(pings).toBeGreaterThan(0)
    expect(log).toHaveBeenCalledWith(`Worker skipped ${pingJob}: its lock is held elsewhere.`)
  } finally {
    log.mockRestore()
  }
})

test('forwards the loop timeoutMs to runJob and aborts its signal on stop', async () => {
  const runtime = countingRuntime()
  const log = spyOn(console, 'log').mockImplementation(() => {})
  let observedTimeoutMs: number | undefined
  let observedSignal: AbortSignal | undefined
  const runJob = async (
    _jobName: string,
    _rt: BackendRuntime,
    _now?: Date,
    options?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<JobRunOutcome> => {
    observedTimeoutMs = options?.timeoutMs
    observedSignal = options?.signal
    return { ranHere: true }
  }

  try {
    const handle = startWorkerLoops(runtime, [{ job: pingJob, intervalMs: 30_000, timeoutMs: 9_000 }], {
      runJob,
    })
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(observedTimeoutMs).toBe(9_000)
    expect(observedSignal?.aborted).toBe(false)

    await handle.stop()

    expect(observedSignal?.aborted).toBe(true)
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
  const runJob = async (): Promise<JobRunOutcome> => {
    release.resolve()
    return { ranHere: true }
  }

  try {
    const handle = startWorkerLoops(runtime, [{ job: pingJob, intervalMs: 30_000 }], { runJob })
    await release.promise

    const stoppedAt = Date.now()
    await handle.stop()

    expect(Date.now() - stoppedAt).toBeLessThan(1_000)
  } finally {
    log.mockRestore()
  }
})

test('stop gives up after shutdownGraceMs even if an iteration never finishes', async () => {
  const runtime = countingRuntime()
  const log = spyOn(console, 'log').mockImplementation(() => {})
  const error = spyOn(console, 'error').mockImplementation(() => {})
  const runJob = async (): Promise<JobRunOutcome> => {
    await new Promise(() => undefined) // never resolves; simulates a job that ignores its signal.
    return { ranHere: true }
  }

  try {
    const handle = startWorkerLoops(runtime, [{ job: pingJob, intervalMs: 30_000 }], {
      runJob,
      shutdownGraceMs: 100,
    })
    await new Promise((resolve) => setTimeout(resolve, 10))

    const stoppedAt = Date.now()
    await handle.stop()
    const elapsedMs = Date.now() - stoppedAt

    expect(elapsedMs).toBeLessThan(1_000)
    expect(error).toHaveBeenCalled()
    expect(String(error.mock.calls.at(-1)?.[0])).toContain('grace period')
  } finally {
    log.mockRestore()
    error.mockRestore()
  }
})
