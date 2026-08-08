import { useQuery, type QueryClient } from '@tanstack/react-query'
import { meResponseSchema } from '@vibestart/contracts'

import type { AuthenticatedTransport } from '@/platform/api'

export const sessionQueryKeys = {
  all: ['session'] as const,
}

export const authQueryKeys = {
  all: [...sessionQueryKeys.all, 'auth'] as const,
  me: () => [...authQueryKeys.all, 'me'] as const,
}

type CurrentUserQueryOptions = {
  transport: Pick<AuthenticatedTransport, 'request'>
  enabled: boolean
}

export function useCurrentUserQuery({ transport, enabled }: CurrentUserQueryOptions) {
  return useQuery({
    queryKey: authQueryKeys.me(),
    enabled,
    queryFn: () => transport.request('/api/users/me', meResponseSchema),
  })
}

/** Drops every session-scoped cache entry (current user, admin dashboard/directory, ...). */
export function clearSessionQueries(queryClient: QueryClient) {
  queryClient.removeQueries({ queryKey: sessionQueryKeys.all })
}
