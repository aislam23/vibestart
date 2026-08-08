import { describe, expect, test } from 'bun:test'

import { UsersService } from './users-service'

const principal = {
  id: '0196f6f8-6600-7000-8000-000000000001',
  email: 'user@example.com',
  displayName: 'Ada',
  role: 'user' as const,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
}

const adminPrincipal = { ...principal, id: '0196f6f8-6600-7000-8000-000000000002', role: 'admin' as const }

function unreachable(name: string) {
  return () => {
    throw new Error(`should not call ${name}`)
  }
}

function createService(overrides: Partial<ConstructorParameters<typeof UsersService>[0]> = {}) {
  return new UsersService({
    adminMetricsReader: { metrics: unreachable('adminMetricsReader.metrics') },
    adminUsersReader: { listUsers: unreachable('adminUsersReader.listUsers') },
    clock: { now: () => new Date('2026-01-08T00:00:00.000Z') },
    profileWriter: { updateProfile: unreachable('profileWriter.updateProfile') },
    userRoleUpdater: { updateRole: unreachable('userRoleUpdater.updateRole') },
    ...overrides,
  })
}

describe('UsersService', () => {
  test('me maps the authenticated principal to a UserDto without hitting the database', () => {
    const service = createService()

    expect(service.me(principal)).toEqual({
      user: {
        id: principal.id,
        email: principal.email,
        displayName: 'Ada',
        role: 'user',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    })
  })

  test('updateProfile writes through the port and returns the updated DTO', async () => {
    const calls: Array<[string, string | null]> = []
    const service = createService({
      profileWriter: {
        updateProfile: async (userId, displayName) => {
          calls.push([userId, displayName])
          return { displayName }
        },
      },
    })

    const result = await service.updateProfile(principal, { displayName: 'Ada Lovelace' })

    expect(calls).toEqual([[principal.id, 'Ada Lovelace']])
    expect(result.user.displayName).toBe('Ada Lovelace')
    expect(result.user.id).toBe(principal.id)
  })

  test('updateProfile can clear the display name', async () => {
    const service = createService({
      profileWriter: {
        updateProfile: async (_userId, displayName) => ({ displayName }),
      },
    })

    const result = await service.updateProfile(principal, { displayName: null })

    expect(result.user.displayName).toBeNull()
  })

  test('metrics asks the reader for accounts created in the last 7 days from the clock', async () => {
    const calls: Date[] = []
    const service = createService({
      adminMetricsReader: {
        metrics: async (createdAfter) => {
          calls.push(createdAfter)
          return { totalUsers: 5, totalAdmins: 1, newUsersLast7Days: 2 }
        },
      },
    })

    const result = await service.metrics()

    expect(calls).toEqual([new Date('2026-01-01T00:00:00.000Z')])
    expect(result).toEqual({ totalUsers: 5, totalAdmins: 1, newUsersLast7Days: 2 })
  })

  test('listUsers passes the query straight through to the reader', async () => {
    const calls: unknown[] = []
    const response = { items: [], page: 1, pageSize: 20, total: 0, hasNext: false }
    const service = createService({
      adminUsersReader: {
        listUsers: async (query) => {
          calls.push(query)
          return response
        },
      },
    })

    const query = { page: 1, pageSize: 20 } as const
    await expect(service.listUsers(query)).resolves.toBe(response)
    expect(calls).toEqual([query])
  })

  test('updateRole passes the actor, target, and requested role through to the updater', async () => {
    const calls: unknown[] = []
    const updated = {
      id: principal.id,
      email: principal.email,
      displayName: principal.displayName,
      role: 'admin' as const,
      createdAt: principal.createdAt.toISOString(),
    }
    const service = createService({
      userRoleUpdater: {
        updateRole: async (input) => {
          calls.push(input)
          return updated
        },
      },
    })

    const result = await service.updateRole(adminPrincipal, principal.id, { role: 'admin' })

    expect(calls).toEqual([
      { actorUserId: adminPrincipal.id, targetUserId: principal.id, role: 'admin' },
    ])
    expect(result).toEqual({ user: updated })
  })
})
