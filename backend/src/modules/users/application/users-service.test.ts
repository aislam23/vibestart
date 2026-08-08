import { describe, expect, test } from 'bun:test'

import { UsersService } from './users-service'

const principal = {
  id: '0196f6f8-6600-7000-8000-000000000001',
  email: 'user@example.com',
  displayName: 'Ada',
  role: 'user' as const,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
}

describe('UsersService', () => {
  test('me maps the authenticated principal to a UserDto without hitting the database', () => {
    const service = new UsersService({
      profileWriter: {
        updateProfile: () => {
          throw new Error('should not be called by me()')
        },
      },
    })

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
    const service = new UsersService({
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
    const service = new UsersService({
      profileWriter: {
        updateProfile: async (_userId, displayName) => ({ displayName }),
      },
    })

    const result = await service.updateProfile(principal, { displayName: null })

    expect(result.user.displayName).toBeNull()
  })
})
