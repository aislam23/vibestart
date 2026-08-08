import { useQuery, type QueryClient } from '@tanstack/react-query'
import { meResponseSchema } from '@vibestart/contracts'

import type { AuthenticatedTransport } from '@/platform/api'

export const sessionQueryKeys = {
  all: ['session'] as const,
}

export const authQueryKeys = {
  all: [...sessionQueryKeys.all, 'auth'] as const,
  // Keyed by the Supabase session's user id, not just a static string: two different principals
  // (one signed in right after another, without an intervening cache purge somehow slipping
  // through) get two distinct, never-populated-for-each-other cache entries instead of one
  // account's cached `/me` response ever being handed back as another's. `null` covers the
  // logged-out case, where the query is disabled anyway.
  me: (userId: string | null) => [...authQueryKeys.all, 'me', userId] as const,
}

type CurrentUserQueryOptions = {
  transport: Pick<AuthenticatedTransport, 'request'>
  enabled: boolean
  /** The Supabase session's user id - known immediately from the session, before this query's own
   * response confirms it. See {@link authQueryKeys.me}. */
  userId: string | null
}

export function useCurrentUserQuery({ transport, enabled, userId }: CurrentUserQueryOptions) {
  return useQuery({
    queryKey: authQueryKeys.me(userId),
    enabled: enabled && userId !== null,
    queryFn: () => transport.request('/api/users/me', meResponseSchema),
  })
}

/** Drops every session-scoped cache entry (current user, admin dashboard/directory, ...). */
export function clearSessionQueries(queryClient: QueryClient) {
  queryClient.removeQueries({ queryKey: sessionQueryKeys.all })
}
