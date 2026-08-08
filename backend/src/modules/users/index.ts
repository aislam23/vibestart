import type { MiddlewareHandler } from 'hono'

import type { DbClient } from '../../db'
import type { AuthHttpEnv } from '../auth-context'
import { UsersService } from './application/users-service'
import { createPrismaUsersRepository } from './infrastructure/users-repository'
import { createUsersRoutes } from './transport/routes'

type CreateUsersModuleOptions = {
  db: DbClient
  requireAuth: MiddlewareHandler<AuthHttpEnv>
}

export function createUsersModule({ db, requireAuth }: CreateUsersModuleOptions) {
  const service = new UsersService({ profileWriter: createPrismaUsersRepository(db) })
  return { routes: createUsersRoutes({ requireAuth, service }) }
}
