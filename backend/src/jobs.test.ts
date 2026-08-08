import { describe, expect, test } from 'bun:test'

import type { BackendRuntime } from './runtime'
import {
  backgroundJobNames,
  createBackgroundJobRegistry,
  isBackgroundJobName,
  runBackgroundJob,
} from './jobs'

const runtime = {} as BackendRuntime

function lockingRuntime({ acquired }: { acquired: boolean }) {
  const calls = { transactions: 0 }
  const prisma = {
    $transaction: async (run: (tx: unknown) => Promise<unknown>) => {
      calls.transactions += 1
      return run({ $queryRaw: async () => [{ acquired }] })
    },
  }
  return { calls, runtime: { prisma } as unknown as BackendRuntime }
}

describe('the production registry ships empty', () => {
  test('lists no jobs', () => {
    expect(backgroundJobNames()).toEqual([])
  })

  test('rejects any job name and says none are registered yet', async () => {
    await expect(runBackgroundJob('anything', runtime)).rejects.toThrow(
      'Unknown job "anything". Available jobs: (none registered yet)',
    )
  })

  test('rejects Object.prototype keys the same as any other unknown name', async () => {
    for (const inherited of ['constructor', 'toString', 'hasOwnProperty']) {
      expect(isBackgroundJobName(inherited)).toBe(false)
      await expect(runBackgroundJob(inherited, runtime)).rejects.toThrow(`Unknown job "${inherited}"`)
    }
  })
})

describe('createBackgroundJobRegistry', () => {
  test('locks a plain-function job by default: it only runs once the advisory lock is acquired', async () => {
    const calls: unknown[] = []
    const now = new Date('2026-04-08T12:00:00.000Z')
    const { runtime: lockedRuntime, calls: lockCalls } = lockingRuntime({ acquired: true })
    const { run } = createBackgroundJobRegistry({
      noop: async (rt, jobNow, signal) => {
        calls.push([rt, jobNow, signal])
      },
    })

    const outcome = await run('noop', lockedRuntime, now)

    expect(lockCalls.transactions).toBe(1)
    expect(outcome).toMatchObject({ ranHere: true })
    expect(calls).toHaveLength(1)
    const [[rt, jobNow, signal]] = calls as [[unknown, Date, AbortSignal]]
    expect(rt).toBe(lockedRuntime)
    expect(jobNow).toBe(now)
    expect(signal).toBeInstanceOf(AbortSignal)
  })

  test('skips a plain-function job, and never calls it, while its lock is held elsewhere', async () => {
    const calls: unknown[] = []
    const { runtime: lockedRuntime } = lockingRuntime({ acquired: false })
    const { run } = createBackgroundJobRegistry({
      noop: async () => {
        calls.push('ran')
      },
    })

    const outcome = await run('noop', lockedRuntime)

    expect(outcome).toEqual({ ranHere: false })
    expect(calls).toEqual([])
  })

  test('a `parallel: true` job runs unlocked, without ever touching the database', async () => {
    const calls: unknown[] = []
    // No `.prisma` at all - if this job touched the lock, this would throw.
    const noPrismaRuntime = {} as BackendRuntime
    const { run } = createBackgroundJobRegistry({
      warm: { run: async (rt, now, signal) => { calls.push([rt, now, signal]) }, parallel: true },
    })

    const outcome = await run('warm', noPrismaRuntime)

    expect(outcome).toEqual({ ranHere: true })
    expect(calls).toHaveLength(1)
  })

  test('a definition-object job without `parallel` still locks by default', async () => {
    const { runtime: lockedRuntime, calls } = lockingRuntime({ acquired: true })
    let ran = false
    const { run } = createBackgroundJobRegistry({
      job: { run: async () => { ran = true } },
    })

    await run('job', lockedRuntime)

    expect(calls.transactions).toBe(1)
    expect(ran).toBe(true)
  })

  test('an explicit timeoutMs override at call time wins over the job definition default', async () => {
    let observedTimeout: number | undefined
    const prisma = {
      $transaction: async (run: (tx: unknown) => Promise<unknown>, options?: { timeout?: number }) => {
        observedTimeout = options?.timeout
        return run({ $queryRaw: async () => [{ acquired: true }] })
      },
    }
    const lockedRuntime = { prisma } as unknown as BackendRuntime
    const { run } = createBackgroundJobRegistry({
      job: { run: async () => {}, timeoutMs: 1_000 },
    })

    await run('job', lockedRuntime, undefined, { timeoutMs: 5_000 })

    expect(observedTimeout).toBe(5_000)
  })

  test('lists every registered job name', () => {
    const { names } = createBackgroundJobRegistry({
      noop: async () => {},
      'db:ping': async () => {},
    })

    expect(names()).toEqual(['noop', 'db:ping'])
  })

  test('rejects an unknown job and names the ones that exist', async () => {
    const { run } = createBackgroundJobRegistry({
      noop: async () => {},
      'db:ping': async () => {},
    })

    await expect(run('missing', runtime)).rejects.toThrow(
      'Unknown job "missing". Available jobs: noop, db:ping',
    )
  })

  test('rejects Object.prototype keys instead of running nothing and reporting success', async () => {
    // `'constructor' in registry` is true. A provider timer configured with that name would exit 0
    // every night while doing no work at all, which looks healthy in every dashboard.
    const { run, isName } = createBackgroundJobRegistry({ noop: async () => {} })

    for (const inherited of ['constructor', 'toString', 'hasOwnProperty']) {
      expect(isName(inherited)).toBe(false)
      await expect(run(inherited, runtime)).rejects.toThrow(`Unknown job "${inherited}"`)
    }
  })

  test('an empty registry reports that nothing is registered yet', async () => {
    const { run } = createBackgroundJobRegistry({})

    await expect(run('anything', runtime)).rejects.toThrow(
      'Unknown job "anything". Available jobs: (none registered yet)',
    )
  })
})
