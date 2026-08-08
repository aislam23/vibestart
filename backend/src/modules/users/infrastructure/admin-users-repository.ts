import { ADMIN_USERS_MAX_PAGE, type AdminUserSummary, type UserRole } from '@vibestart/contracts'

import { acquireUserRoleMutationLock, isLockTimeoutError, type DbClient } from '../../../db'
import { Prisma } from '../../../generated/prisma/client'
import type { AdminMetricsReader, AdminUsersReader, UserRoleUpdater } from '../application/ports'
import { UsersFailure } from '../domain/errors'

type AdminUserRow = {
  id: string
  email: string
  displayName: string | null
  role: UserRole
  createdAt: Date
}

/**
 * Reads the admin users directory by joining `profiles` (this backend's own table, via Prisma)
 * against `auth.users` (owned by Supabase GoTrue) for email - `profiles` deliberately has no email
 * column of its own, see backend/README.md. The join is the ONE place in the backend that reads
 * `auth.users`, and it does so with a raw, read-only query: never write to a GoTrue-owned table
 * from application code.
 */
export function createAdminUsersRepository(
  db: DbClient,
): AdminMetricsReader & AdminUsersReader & UserRoleUpdater {
  return {
    async metrics(createdAfter) {
      const [totalUsers, activeAdminRows, newUsersLast7Days] = await db.$transaction([
        db.profile.count(),
        countActiveAdmins(db),
        db.profile.count({ where: { createdAt: { gte: createdAfter } } }),
      ])
      return { totalUsers, totalAdmins: toCount(activeAdminRows), newUsersLast7Days }
    },

    async listUsers({ page, pageSize, q }) {
      const offset = (page - 1) * pageSize
      const search = searchClause(q)

      const [rows, totals] = await Promise.all([
        db.$queryRaw<AdminUserRow[]>(Prisma.sql`
          SELECT p.id, u.email, p.display_name AS "displayName", p.role, p.created_at AS "createdAt"
          FROM public.profiles p
          JOIN auth.users u ON u.id = p.id
          ${search}
          ORDER BY p.created_at DESC, p.id DESC
          LIMIT ${pageSize} OFFSET ${offset}
        `),
        db.$queryRaw<{ total: bigint }[]>(Prisma.sql`
          SELECT COUNT(*)::bigint AS total
          FROM public.profiles p
          JOIN auth.users u ON u.id = p.id
          ${search}
        `),
      ])
      const total = Number(totals[0]?.total ?? 0)

      return {
        items: rows.map(toAdminUserSummary),
        page,
        pageSize,
        total,
        hasNext: page < ADMIN_USERS_MAX_PAGE && page * pageSize < total,
      }
    },

    async updateRole({ actorUserId, targetUserId, role }) {
      try {
        return await db.$transaction(
          async (tx) => {
            await acquireUserRoleMutationLock(tx)

            // Re-authorize the actor *inside* the lock, after it is held: the caller's principal
            // was loaded by `requireAuth`/`requireAdmin` before this request reached here, and
            // could since have been demoted by a role change that committed while this request was
            // queued behind the advisory lock above. Trusting that stale, already-passed
            // middleware check would let a just-demoted actor's in-flight request still mutate
            // roles.
            const actor = await tx.profile.findUnique({ where: { id: actorUserId } })
            if (!actor || actor.role !== 'admin') {
              throw new UsersFailure('forbidden', 'Administrator access is required')
            }

            const target = await tx.profile.findUnique({ where: { id: targetUserId } })
            if (!target) {
              throw new UsersFailure('not_found', 'User not found')
            }
            if (target.role === role) {
              return toAdminUserSummary(await readAdminUserRow(tx, target.id))
            }
            if (target.id === actorUserId && role !== 'admin') {
              throw new UsersFailure('role_conflict', 'You cannot remove your own administrator role')
            }
            if (target.role === 'admin' && role === 'user') {
              // Active accounts only (joined with auth.users), matching /api/admin/metrics: a
              // profile whose auth.users row is gone must not count toward "an administrator
              // remains" - see the README's "Recovery" note for how to promote after that happens.
              const adminCount = toCount(await countActiveAdmins(tx))
              if (adminCount <= 1) {
                throw new UsersFailure('role_conflict', 'At least one administrator must remain')
              }
            }

            await tx.profile.update({ where: { id: target.id }, data: { role } })
            return toAdminUserSummary(await readAdminUserRow(tx, target.id))
          },
          // A queued role change (waiting on the advisory lock) can otherwise outlive Prisma's
          // default interactive-transaction timeout under load; this is unrelated to and far below
          // `runWithJobLock`'s minutes-long budget for background jobs.
          { timeout: 10_000 },
        )
      } catch (error) {
        if (isLockTimeoutError(error)) {
          throw new UsersFailure(
            'lock_timeout',
            'Too many concurrent role changes; try again shortly',
            5,
          )
        }
        throw error
      }
    },
  }
}

async function readAdminUserRow(tx: Pick<DbClient, '$queryRaw'>, id: string): Promise<AdminUserRow> {
  const [row] = await tx.$queryRaw<AdminUserRow[]>(Prisma.sql`
    SELECT p.id, u.email, p.display_name AS "displayName", p.role, p.created_at AS "createdAt"
    FROM public.profiles p
    JOIN auth.users u ON u.id = p.id
    WHERE p.id = ${id}
  `)
  if (!row) {
    throw new UsersFailure('not_found', 'User not found')
  }
  return row
}

/**
 * Counts administrators with an active (existing) `auth.users` row, not bare `profiles` rows -
 * used by both `/api/admin/metrics` and the last-admin invariant above, so the two never disagree
 * about what "an administrator" means. See the README's "Recovery" note for the one case this
 * excludes: a profile whose auth.users row was deleted.
 */
function countActiveAdmins(db: Pick<DbClient, '$queryRaw'>) {
  return db.$queryRaw<{ total: bigint }[]>(Prisma.sql`
    SELECT COUNT(*)::bigint AS total
    FROM public.profiles p
    JOIN auth.users u ON u.id = p.id
    WHERE p.role = 'admin'
  `)
}

function toCount(rows: { total: bigint }[]) {
  return Number(rows[0]?.total ?? 0)
}

function searchClause(q: string | undefined) {
  if (!q) return Prisma.sql``
  const pattern = `%${escapeLikePattern(q)}%`
  return Prisma.sql`WHERE u.email ILIKE ${pattern} OR p.display_name ILIKE ${pattern}`
}

/** Postgres's default `LIKE`/`ILIKE` escape character is `\`, so a literal `%`, `_`, or `\` in the
 * search term must not act as a wildcard. */
function escapeLikePattern(value: string) {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`)
}

function toAdminUserSummary(row: AdminUserRow): AdminUserSummary {
  return {
    id: row.id,
    email: row.email,
    displayName: row.displayName,
    role: row.role,
    createdAt: row.createdAt.toISOString(),
  }
}
