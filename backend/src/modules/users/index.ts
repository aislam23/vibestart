import type { MiddlewareHandler } from 'hono'

import type { DbClient } from '../../db'
import type { AppEnv } from '../../env'
import { createFixedWindowRateLimit } from '../../http/security'
import type { AuthHttpEnv } from '../auth-context'
import { UsersService } from './application/users-service'
import { createAdminUsersRepository } from './infrastructure/admin-users-repository'
import { createPrismaUsersRepository } from './infrastructure/users-repository'
import { createUsersRoutes } from './transport/routes'

type CreateUsersModuleOptions = {
  db: DbClient
  env: Pick<AppEnv, 'ADMIN_USERS_READ_RATE_LIMIT_MAX' | 'ADMIN_USERS_READ_RATE_LIMIT_WINDOW_SECONDS'>
  requireAdmin: MiddlewareHandler<AuthHttpEnv>
  requireAuth: MiddlewareHandler<AuthHttpEnv>
}

export function createUsersModule({ db, env, requireAdmin, requireAuth }: CreateUsersModuleOptions) {
  const adminUsersRepository = createAdminUsersRepository(db)
  const service = new UsersService({
    adminMetricsReader: adminUsersRepository,
    adminUsersReader: adminUsersRepository,
    clock: { now: () => new Date() },
    profileWriter: createPrismaUsersRepository(db),
    userRoleUpdater: adminUsersRepository,
  })
  const adminUsersReadRateLimit = createFixedWindowRateLimit<AuthHttpEnv>({
    errorMessage: 'Too many admin users-directory requests',
    key: (c) => c.var.user.id,
    max: env.ADMIN_USERS_READ_RATE_LIMIT_MAX,
    windowSeconds: env.ADMIN_USERS_READ_RATE_LIMIT_WINDOW_SECONDS,
  })

  return createUsersRoutes({ adminUsersReadRateLimit, requireAdmin, requireAuth, service })
}
