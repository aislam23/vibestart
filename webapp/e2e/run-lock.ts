import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { artifactsDir } from './env'

export const runLockPath = resolve(artifactsDir, 'run.lock')

// Generous on purpose: this only exists to reclaim a lock left behind by a run that was killed
// before its own teardown ran, not to bound how long a real run may take. A full local run
// (Docker stack up, migrations, seeding, every spec) is minutes, not tens of minutes - anything
// older than this is a leftover, not a slow-but-alive run.
const staleLockMaxAgeMs = 30 * 60 * 1000

// Playwright re-executes the *entire* playwright.config.ts module - including this call, made at
// its top level - more than once within a single `playwright test` invocation: once in the
// orchestrator process, and again in every worker process it spawns to actually run tests (the
// same behavior plan.ts's own doc comment independently documents, there causing a port-scan
// mismatch instead of a lock conflict). Worker processes inherit `process.env` from the
// orchestrator, so the first successful acquisition marks itself here; every later evaluation
// within the same process tree sees this already set and skips straight past the file-based check
// - it does not need to re-acquire a lock its own ancestor already holds. A second, genuinely
// separate `bun run e2e:webapp` invocation starts with none of this in its environment (env vars
// set via `process.env` never propagate back out to the parent shell or across unrelated
// processes), so it always falls through to the real check below.
const lockOwnerEnvVar = 'VIBESTART_E2E_RUN_LOCK_OWNER'

/**
 * Acquires an exclusive lock for the duration of one `bun run e2e:webapp` run, so a second,
 * concurrent invocation on the same machine fails fast with a clear message instead of both runs
 * fighting over the same fixed Docker project name/container names/scratch files (env.ts,
 * `composeProjectName`) and silently corrupting each other's stack. Throws if another run already
 * holds the lock and it does not look stale.
 *
 * `wx` (`O_CREAT | O_EXCL | O_WRONLY`) is the exclusivity primitive: the OS guarantees only one
 * caller ever succeeds in creating the file, even under a race, so there is no separate
 * check-then-create window to get wrong.
 *
 * Stale-lock detection covers the one case that would otherwise wedge every future run forever: a
 * previous run's process died (killed, crashed, machine restarted) before `releaseRunLock()`
 * (called from global-teardown.ts) ever ran. A lock is stale when the pid it recorded is no longer
 * alive, or when it is simply older than any real run should take - either way this removes it and
 * retries once instead of refusing to proceed.
 */
export function acquireRunLock(): void {
  if (process.env[lockOwnerEnvVar]) return // Already held by an ancestor process in this same run.

  mkdirSync(artifactsDir, { recursive: true })

  if (tryAcquire()) {
    process.env[lockOwnerEnvVar] = String(process.pid)
    return
  }

  if (isStale()) {
    rmSync(runLockPath, { force: true })
    if (tryAcquire()) {
      process.env[lockOwnerEnvVar] = String(process.pid)
      return
    }
  }

  throw new Error(
    `Another e2e run appears to already be in progress (lock file: ${runLockPath}). e2e runs are ` +
      'serialized per machine - see webapp/README.md, "E2E". If no other run is actually active ' +
      `(e.g. a previous run was killed before cleanup), delete ${runLockPath} and try again.`,
  )
}

/** Releases the lock {@link acquireRunLock} took. Idempotent - safe to call even when no lock is
 * held (e.g. global-teardown.ts running after global-setup.ts already released it on its own
 * failure path). */
export function releaseRunLock(): void {
  rmSync(runLockPath, { force: true })
}

function tryAcquire(): boolean {
  try {
    const fd = openSync(runLockPath, 'wx')
    writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }))
    closeSync(fd)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    return false
  }
}

function isStale(): boolean {
  let recorded: { pid?: unknown; startedAt?: unknown }
  try {
    recorded = JSON.parse(readFileSync(runLockPath, 'utf8'))
  } catch {
    return true // Unreadable/corrupt lock file - treat as stale rather than wedging forever.
  }

  const startedAt = typeof recorded.startedAt === 'string' ? Date.parse(recorded.startedAt) : NaN
  if (!Number.isNaN(startedAt) && Date.now() - startedAt > staleLockMaxAgeMs) return true

  const pid = typeof recorded.pid === 'number' ? recorded.pid : NaN
  if (Number.isNaN(pid)) return true

  try {
    // Signal 0: existence check only, never actually signals the process.
    process.kill(pid, 0)
    return false
  } catch {
    return true // ESRCH (no such process) - the run that held this lock is definitely gone.
  }
}
