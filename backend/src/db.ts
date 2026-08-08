import { PrismaPg } from '@prisma/adapter-pg'

import { Prisma, PrismaClient } from './generated/prisma/client'

export function createPrisma(connectionString: string) {
  const adapter = new PrismaPg({ connectionString: normalizePgConnectionString(connectionString) })
  return new PrismaClient({ adapter })
}

export type DbClient = ReturnType<typeof createPrisma>

/** How long a background job may hold its lock before Prisma expires the holding transaction. */
export const defaultJobLockTimeoutMs = 15 * 60 * 1000

/**
 * Runs `job` only if no other process is already running it.
 *
 * `croner` (or any in-process scheduler) protects a job from overlapping itself inside one
 * process; two copies of the process are two independent protections, which is why the guard
 * lives in the database. The lock is held by the surrounding transaction, so it is released when
 * the job finishes and when the process dies - no stale lock survives a crash.
 *
 * **The lock is only as long as `timeoutMs`.** It is Prisma's interactive-transaction timeout, not
 * a Postgres setting - do not go looking at `statement_timeout`. If the job outruns it, Prisma
 * rolls the transaction back and the lock is released while the job is still working: another
 * process can then start the same job, and this one fails after its side effects have already
 * landed. Give `timeoutMs` real headroom over the slowest run, and make jobs that can approach it
 * idempotent. That failure arrives as `JobLockExpiredError` so callers can say what actually
 * happened instead of logging a generic error.
 *
 * The other cost is an open transaction - and therefore a held connection - for the whole run, on
 * top of the connection the job itself uses.
 *
 * `job` receives an `AbortSignal` - the runner's way of telling a job to wind down. It fires when
 * this lock expires mid-run (see above: the job is still executing JS after Prisma has already
 * rolled its transaction back) and when `signal` (an external, e.g. process-shutdown, signal) is
 * aborted. It is cooperative, not forcible: a job that never checks it never learns to stop.
 */
export async function runWithJobLock<Result>(
  prisma: Pick<DbClient, '$transaction'>,
  jobName: string,
  job: (signal: AbortSignal) => Promise<Result>,
  { timeoutMs = defaultJobLockTimeoutMs, signal: parentSignal }: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<{ ranHere: true; result: Result } | { ranHere: false }> {
  // Set when the transaction actually starts. Time spent queueing for a connection is not time
  // holding the lock, so it must not count: on a saturated pool Prisma rejects with the same
  // error code before the transaction exists, and blaming that on the lock would send an
  // operator after a timeout instead of after the pool.
  let lockHeldSince: number | undefined

  const controller = new AbortController()
  const forwardAbort = () => controller.abort(parentSignal?.reason)
  if (parentSignal) {
    if (parentSignal.aborted) forwardAbort()
    else parentSignal.addEventListener('abort', forwardAbort, { once: true })
  }

  try {
    return await prisma.$transaction(
      async (tx) => {
        lockHeldSince = Date.now()

        const [{ acquired }] = await tx.$queryRaw<{ acquired: boolean }[]>(
          Prisma.sql`SELECT pg_try_advisory_xact_lock(hashtextextended(${`background-job:${jobName}`}, 0)) AS acquired`,
        )

        if (!acquired) return { ranHere: false as const }

        return { ranHere: true as const, result: await job(controller.signal) }
      },
      { timeout: timeoutMs },
    )
  } catch (error) {
    // P2028 covers every transaction-API failure, so the code alone does not identify an expiry:
    // a job that runs its own nested transaction propagates the same code when that inner one
    // times out. Only the time this transaction was open can tell the two apart.
    if (lockHeldSince !== undefined && isPrismaTransactionFailure(error)) {
      const elapsedMs = Date.now() - lockHeldSince

      if (elapsedMs >= timeoutMs) {
        controller.abort(new Error(`job lock for "${jobName}" expired`))
        throw new JobLockExpiredError(jobName, timeoutMs, elapsedMs, error)
      }
    }

    throw error
  } finally {
    if (parentSignal) parentSignal.removeEventListener('abort', forwardAbort)
  }
}

/** A job ran longer than its lock, so the lock was released while the job was still working. */
export class JobLockExpiredError extends Error {
  constructor(
    readonly jobName: string,
    readonly timeoutMs: number,
    readonly elapsedMs: number,
    override readonly cause: unknown,
  ) {
    super(
      `Background job "${jobName}" ran for ${elapsedMs}ms, past its ${timeoutMs}ms lock, so the lock was released while the job was still working.`,
    )
    this.name = 'JobLockExpiredError'
  }
}

export function isJobLockExpiry(error: unknown): error is JobLockExpiredError {
  return error instanceof JobLockExpiredError
}

function isPrismaTransactionFailure(error: unknown) {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'P2028'
  )
}

/** Postgres's `lock_not_available` error code, raised when a statement hits `lock_timeout`. */
const POSTGRES_LOCK_NOT_AVAILABLE = '55P03'

export function isLockTimeoutError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  // The `@prisma/adapter-pg` driver adapter wraps a raw-query failure as
  // `PrismaClientKnownRequestError` with its own generic `code: 'P2010'` ("raw query failed") -
  // the actual Postgres error code only shows up nested (`meta.driverAdapterError`, itself
  // provider- and version-shaped) or in the message text Prisma composes
  // ("Raw query failed. Code: `55P03`. Message: ..."). The message text is the one place this
  // is stable across Prisma/driver-adapter versions, so it is checked first; the structured
  // fields are kept as a fallback in case a future version simplifies this.
  const candidate = error as {
    code?: unknown
    message?: unknown
    meta?: { code?: unknown; message?: unknown; driverAdapterError?: { cause?: { code?: unknown } } }
  }
  const messageContains = (value: unknown) =>
    typeof value === 'string' && value.includes(POSTGRES_LOCK_NOT_AVAILABLE)

  return (
    candidate.code === POSTGRES_LOCK_NOT_AVAILABLE ||
    candidate.meta?.code === POSTGRES_LOCK_NOT_AVAILABLE ||
    candidate.meta?.driverAdapterError?.cause?.code === POSTGRES_LOCK_NOT_AVAILABLE ||
    messageContains(candidate.message) ||
    messageContains(candidate.meta?.message)
  )
}

/**
 * Serializes every admin role change behind one Postgres advisory lock, held for the transaction.
 *
 * Without it, two concurrent role changes (e.g. two admins each demoting the other, or two
 * requests racing to demote the last remaining admin) can each read "more than one admin exists"
 * before either write commits, and both proceed - leaving zero admins. Taking this lock first
 * forces role changes through one at a time, so the second request in any race sees the first
 * one's already-committed write.
 *
 * `SET LOCAL lock_timeout` bounds how long a request waits behind another one already holding this
 * lock, scoped to this transaction only so it never leaks onto unrelated statements sharing a
 * pooled connection. A request that waits past it gets Postgres error 55P03
 * (`lock_not_available`), which the caller (`admin-users-repository.ts`) maps to `409 CONFLICT`
 * with a `Retry-After` header instead of hanging.
 */
const lockTimeoutPattern = /^\d+(ms|s|min|h|d)?$/

export async function acquireUserRoleMutationLock(
  tx: Pick<DbClient, '$executeRaw' | '$executeRawUnsafe'>,
  { lockTimeout = '5s' }: { lockTimeout?: string } = {},
) {
  // Postgres's `SET` does not accept a bind parameter for the value in every driver path, so this
  // goes through `$executeRawUnsafe` instead of a tagged template - safe here only because
  // `lockTimeout` is always one of this module's own literals, never external input. The regex
  // guards that invariant instead of trusting it silently.
  if (!lockTimeoutPattern.test(lockTimeout)) {
    throw new Error(`Invalid lock timeout "${lockTimeout}"`)
  }
  await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '${lockTimeout}'`)
  // `$executeRaw`, not `$queryRaw`: `pg_advisory_xact_lock` returns `void`, a column type the
  // driver adapter cannot deserialize into a result row.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'users:role-mutation'}))`
}

/**
 * Normalizes managed-Postgres connection strings that use `sslmode=require` (e.g. DigitalOcean
 * Managed PostgreSQL) so the Prisma PostgreSQL adapter uses libpq-compatible TLS handling.
 */
export function normalizePgConnectionString(connectionString: string) {
  const url = new URL(connectionString)
  const sslMode = url.searchParams.get('sslmode')
  const useLibpqCompat = url.searchParams.get('uselibpqcompat')

  if (sslMode === 'require' && useLibpqCompat === null) {
    url.searchParams.set('uselibpqcompat', 'true')
  }

  return url.toString()
}
