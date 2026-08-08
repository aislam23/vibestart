import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { AdminUsersQuery, UserRole } from '@vibestart/contracts'

import { useAuth } from '@/features/auth'
import { getAdminDashboard, getAdminUsers, updateAdminUserRole } from './api'

// Keyed by the acting administrator's own Supabase user id (not the users being administered) -
// see auth/queries.ts's `authQueryKeys.me` for why: it keeps one admin's cached dashboard/directory
// data from ever being handed back to a different principal that signs in after them without an
// intervening cache purge somehow slipping through.
const adminQueryKeys = {
  all: (adminUserId: string | null) => ['session', 'admin', adminUserId] as const,
  dashboard: (adminUserId: string | null) => [...adminQueryKeys.all(adminUserId), 'dashboard'] as const,
  users: (adminUserId: string | null, query: AdminUsersQuery) =>
    [...adminQueryKeys.all(adminUserId), 'users', query] as const,
}

export function useAdminDashboardQuery() {
  const auth = useAuth()
  const adminUserId = auth.user?.id ?? null
  return useQuery({
    queryKey: adminQueryKeys.dashboard(adminUserId),
    enabled: adminUserId !== null,
    queryFn: () => getAdminDashboard(auth.transport),
  })
}

export function useAdminUsersQuery(query: AdminUsersQuery) {
  const auth = useAuth()
  const adminUserId = auth.user?.id ?? null
  return useQuery({
    queryKey: adminQueryKeys.users(adminUserId, query),
    enabled: adminUserId !== null,
    queryFn: () => getAdminUsers(auth.transport, query),
  })
}

export function useUpdateAdminUserRoleMutation() {
  const auth = useAuth()
  const adminUserId = auth.user?.id ?? null
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ role, userId }: { role: UserRole; userId: string }) =>
      updateAdminUserRole(auth.transport, userId, { role }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: adminQueryKeys.dashboard(adminUserId) }),
        queryClient.invalidateQueries({ queryKey: [...adminQueryKeys.all(adminUserId), 'users'] }),
      ])
    },
  })
}
