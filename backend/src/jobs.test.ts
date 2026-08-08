import { describe, expect, test } from 'bun:test'

import type { BackendRuntime } from './runtime'
import {
  backgroundJobNames,
  createBackgroundJobRegistry,
  isBackgroundJobName,
  runBackgroundJob,
} from './jobs'

const runtime = {} as BackendRuntime

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
  test('runs a registered job and passes the runtime and now through', async () => {
    const calls: unknown[] = []
    const now = new Date('2026-04-08T12:00:00.000Z')
    const { run } = createBackgroundJobRegistry({
      noop: async (rt, jobNow) => {
        calls.push([rt, jobNow])
      },
    })

    await run('noop', runtime, now)

    expect(calls).toEqual([[runtime, now]])
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
