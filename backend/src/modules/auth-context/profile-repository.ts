import type { UserRole } from '@vibestart/contracts'

import type { DbClient } from '../../db'

export type ProfileRecord = {
  id: string
  role: UserRole
  displayName: string | null
  createdAt: Date
}

/**
 * Loads the profile row for an authenticated Supabase user, creating it on first sight.
 *
 * This replaces a database trigger on `auth.users`: GoTrue owns that schema, so provisioning
 * happens here instead, the first time a valid JWT for a `sub` with no `profiles` row is seen.
 * `create` races safely against a concurrent request for the same brand-new user - on a unique
 * violation (P2002) it re-reads the row the other request just inserted instead of failing.
 */
export async function ensureProfile(
  db: DbClient,
  userId: string,
  displayName: string | null,
): Promise<ProfileRecord> {
  const existing = await db.profile.findUnique({ where: { id: userId } })
  if (existing) return existing

  try {
    return await db.profile.create({ data: { id: userId, displayName } })
  } catch (error) {
    if (isUniqueConstraintViolation(error)) {
      const raced = await db.profile.findUnique({ where: { id: userId } })
      if (raced) return raced
    }
    throw error
  }
}

function isUniqueConstraintViolation(error: unknown) {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'P2002'
  )
}
