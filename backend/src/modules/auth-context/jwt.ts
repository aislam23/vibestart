import { emailSchema, userIdSchema } from '@vibestart/contracts'
import { jwtVerify } from 'jose'
import { z } from 'zod'

import { AuthContextFailure } from './errors'

// Supabase (GoTrue) issues HS256 access tokens signed with the project's shared JWT secret
// (infra/supabase's JWT_SECRET, also used by PostgREST, Realtime, and Storage). `aud` and the
// Postgres `role` claim are both "authenticated" for a signed-in user; anon/service-role tokens
// carry a different `role` and must not authenticate a request here.
const supabaseAccessTokenSchema = z.object({
  sub: userIdSchema,
  email: emailSchema,
  aud: z.string(),
  role: z.string(),
  user_metadata: z.record(z.string(), z.unknown()).optional(),
})

export type SupabasePrincipal = {
  userId: string
  email: string
  displayName: string | null
}

function secretKey(secret: string) {
  return new TextEncoder().encode(secret)
}

export async function verifySupabaseAccessToken(
  token: string | undefined,
  supabaseJwtSecret: string,
): Promise<SupabasePrincipal> {
  if (!token) {
    throw new AuthContextFailure('missing_token', 'Authentication is required')
  }

  let payload: unknown
  try {
    ;({ payload } = await jwtVerify(token, secretKey(supabaseJwtSecret), {
      algorithms: ['HS256'],
    }))
  } catch {
    throw new AuthContextFailure('invalid_token', 'Access token is invalid or expired')
  }

  const parsed = supabaseAccessTokenSchema.safeParse(payload)
  if (!parsed.success || parsed.data.aud !== 'authenticated' || parsed.data.role !== 'authenticated') {
    throw new AuthContextFailure('invalid_token', 'Access token is invalid or expired')
  }

  const displayName = parsed.data.user_metadata?.display_name
  return {
    userId: parsed.data.sub,
    email: parsed.data.email,
    displayName: typeof displayName === 'string' ? displayName : null,
  }
}
