import type { DbClient } from '../../../db'
import type { ProfileWriter } from '../application/ports'

export function createPrismaUsersRepository(db: DbClient): ProfileWriter {
  return {
    async updateProfile(userId, displayName) {
      const updated = await db.profile.update({
        where: { id: userId },
        data: { displayName },
        select: { displayName: true },
      })
      return updated
    },
  }
}
