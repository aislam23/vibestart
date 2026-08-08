import type { AdminUsersQuery, UpdateProfileRequest, UpdateUserRoleRequest, UserDto } from '@vibestart/contracts'

import type { AuthenticatedPrincipal } from '../../auth-context'
import type { AdminMetricsReader, AdminUsersReader, Clock, ProfileWriter, UserRoleUpdater } from './ports'

type UsersServiceDependencies = {
  adminMetricsReader: AdminMetricsReader
  adminUsersReader: AdminUsersReader
  clock: Clock
  profileWriter: ProfileWriter
  userRoleUpdater: UserRoleUpdater
}

export class UsersService {
  constructor(private readonly dependencies: UsersServiceDependencies) {}

  me(principal: AuthenticatedPrincipal) {
    return { user: this.userDto(principal) }
  }

  async updateProfile(principal: AuthenticatedPrincipal, input: UpdateProfileRequest) {
    const updated = await this.dependencies.profileWriter.updateProfile(
      principal.id,
      input.displayName,
    )
    return {
      user: this.userDto({ ...principal, displayName: updated.displayName }),
    }
  }

  metrics() {
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000
    const createdAfter = new Date(this.dependencies.clock.now().getTime() - sevenDaysMs)
    return this.dependencies.adminMetricsReader.metrics(createdAfter)
  }

  listUsers(query: AdminUsersQuery) {
    return this.dependencies.adminUsersReader.listUsers(query)
  }

  async updateRole(principal: AuthenticatedPrincipal, targetUserId: string, input: UpdateUserRoleRequest) {
    return {
      user: await this.dependencies.userRoleUpdater.updateRole({
        actorUserId: principal.id,
        targetUserId,
        role: input.role,
      }),
    }
  }

  private userDto(principal: AuthenticatedPrincipal): UserDto {
    return {
      id: principal.id,
      email: principal.email,
      displayName: principal.displayName,
      role: principal.role,
      createdAt: principal.createdAt.toISOString(),
    }
  }
}
