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
 */
export async function runWithJobLock<Result>(
  prisma: Pick<DbClient, '$transaction'>,
  jobName: string,
  job: () => Promise<Result>,
  { timeoutMs = defaultJobLockTimeoutMs }: { timeoutMs?: number } = {},
): Promise<{ ranHere: true; result: Result } | { ranHere: false }> {
  // Set when the transaction actually starts. Time spent queueing for a connection is not time
  // holding the lock, so it must not count: on a saturated pool Prisma rejects with the same
  // error code before the transaction exists, and blaming that on the lock would send an
  // operator after a timeout instead of after the pool.
  let lockHeldSince: number | undefined

  try {
    return await prisma.$transaction(
      async (tx) => {
        lockHeldSince = Date.now()

        const [{ acquired }] = await tx.$queryRaw<{ acquired: boolean }[]>(
          Prisma.sql`SELECT pg_try_advisory_xact_lock(hashtextextended(${`background-job:${jobName}`}, 0)) AS acquired`,
        )

        if (!acquired) return { ranHere: false as const }

        return { ranHere: true as const, result: await job() }
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
        throw new JobLockExpiredError(jobName, timeoutMs, elapsedMs, error)
      }
    }

    throw error
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

/**
 * Serializes every admin role change behind one Postgres advisory lock, held for the transaction.
 *
 * Without it, two concurrent role changes (e.g. two admins each demoting the other, or two
 * requests racing to demote the last remaining admin) can each read "more than one admin exists"
 * before either write commits, and both proceed - leaving zero admins. Taking this lock first
 * forces role changes through one at a time, so the second request in any race sees the first
 * one's already-committed write.
 */
export async function acquireUserRoleMutationLock(tx: Pick<DbClient, '$executeRaw'>) {
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
