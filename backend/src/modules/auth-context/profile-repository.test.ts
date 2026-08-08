import { describe, expect, test } from 'bun:test'

import type { DbClient } from '../../db'
import { ensureProfile } from './profile-repository'

function createFakeDb() {
  const profiles = new Map<string, { id: string; role: 'user' | 'admin'; displayName: string | null; createdAt: Date }>()
  return {
    profiles,
    db: {
      profile: {
        findUnique: async ({ where }: { where: { id: string } }) => profiles.get(where.id) ?? null,
        create: async ({ data }: { data: { id: string; displayName: string | null } }) => {
          if (profiles.has(data.id)) {
            throw Object.assign(new Error('unique constraint'), { code: 'P2002' })
          }
          const record = { id: data.id, role: 'user' as const, displayName: data.displayName, createdAt: new Date() }
          profiles.set(data.id, record)
          return record
        },
      },
    } as unknown as DbClient,
  }
}

describe('ensureProfile', () => {
  test('creates a profile on first sight of a user', async () => {
    const { db } = createFakeDb()

    const created = await ensureProfile(db, 'user-1', 'Ada')

    expect(created).toMatchObject({ id: 'user-1', role: 'user', displayName: 'Ada' })
  })

  test('returns the existing profile without writing again', async () => {
    const { db, profiles } = createFakeDb()
    await ensureProfile(db, 'user-1', 'Ada')

    const second = await ensureProfile(db, 'user-1', 'Different Name')

    expect(second.displayName).toBe('Ada')
    expect(profiles.size).toBe(1)
  })

  test('recovers from a concurrent create by re-reading the winning row', async () => {
    const { db, profiles } = createFakeDb()
    profiles.set('user-1', { id: 'user-1', role: 'user', displayName: 'Winner', createdAt: new Date() })
    const racedDb = {
      profile: {
        findUnique: db.profile.findUnique,
        create: async () => {
          throw Object.assign(new Error('unique constraint'), { code: 'P2002' })
        },
      },
    } as unknown as DbClient

    const result = await ensureProfile(racedDb, 'user-1', 'Loser')

    expect(result.displayName).toBe('Winner')
  })
})
