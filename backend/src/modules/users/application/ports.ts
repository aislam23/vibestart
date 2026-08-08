import type { AdminDashboardResponse, AdminUserSummary, AdminUsersQuery, UserRole } from '@vibestart/contracts'

export type ProfileWriter = {
  updateProfile(userId: string, displayName: string | null): Promise<{ displayName: string | null }>
}

export type AdminMetricsReader = {
  metrics(createdAfter: Date): Promise<AdminDashboardResponse>
}

export type AdminUsersReader = {
  listUsers(query: AdminUsersQuery): Promise<{
    items: AdminUserSummary[]
    page: number
    pageSize: number
    total: number
    hasNext: boolean
  }>
}

export type UserRoleUpdater = {
  updateRole(input: {
    actorUserId: string
    targetUserId: string
    role: UserRole
  }): Promise<AdminUserSummary>
}

export type Clock = {
  now(): Date
}
