import type { UpdateProfileRequest, UserDto } from '@vibestart/contracts'

import type { AuthenticatedPrincipal } from '../../auth-context'
import type { ProfileWriter } from './ports'

type UsersServiceDependencies = {
  profileWriter: ProfileWriter
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
