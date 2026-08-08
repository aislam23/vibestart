import type { DbClient } from '../../db'
import { verifySupabaseAccessToken } from './jwt'
import { createRequireAuth, type AuthenticatedPrincipal, type AuthHttpEnv } from './middleware'
import { ensureProfile } from './profile-repository'

type CreateAuthContextOptions = {
  db: DbClient
  supabaseJwtSecret: string
}

/**
 * The authentication/principal golden path: verifies the Supabase-issued JWT on every request and
 * loads the app-level role from `profiles` in Postgres (never from JWT claims), so a role change
 * made through the (future) admin module takes effect on the very next request instead of waiting
 * for a token to expire.
 */
export function createAuthContext({ db, supabaseJwtSecret }: CreateAuthContextOptions) {
  const requireAuth = createRequireAuth(async (accessToken) => {
    const supabasePrincipal = await verifySupabaseAccessToken(accessToken, supabaseJwtSecret)
    const profile = await ensureProfile(db, supabasePrincipal.userId, supabasePrincipal.displayName)

    return {
      id: profile.id,
      email: supabasePrincipal.email,
      role: profile.role,
      displayName: profile.displayName,
      createdAt: profile.createdAt,
    }
  })

  return { requireAuth }
}

export type { AuthenticatedPrincipal, AuthHttpEnv }
