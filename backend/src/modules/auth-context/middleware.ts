import type { UserRole } from '@vibestart/contracts'
import { createMiddleware } from 'hono/factory'

import { AppError } from '../../http/errors'
import { executeAuthContext } from './errors'

export type AuthenticatedPrincipal = {
  id: string
  email: string
  role: UserRole
  displayName: string | null
  createdAt: Date
}

export type AuthHttpEnv = {
  Variables: {
    user: AuthenticatedPrincipal
  }
}

export function createRequireAuth(
  authenticate: (accessToken: string | undefined) => Promise<AuthenticatedPrincipal>,
) {
  return createMiddleware<AuthHttpEnv>(async (c, next) => {
    const accessToken = bearerToken(c.req.header('authorization'))
    const user = await executeAuthContext(() => authenticate(accessToken))
    c.set('user', user)
    await next()
  })
}

function bearerToken(authorization: string | undefined) {
  if (!authorization?.startsWith('Bearer ')) return undefined
  return authorization.slice('Bearer '.length)
}

/**
 * Must run after `requireAuth` (needs `c.var.user`). Role comes from `AuthenticatedPrincipal`,
 * which `requireAuth` already loaded from `profiles` on this request - never from JWT claims - so
 * this check is always current with the latest role, including one changed a moment ago by the
 * admin module.
 */
export function createRequireAdmin() {
  return createMiddleware<AuthHttpEnv>(async (c, next) => {
    if (c.var.user.role !== 'admin') {
      throw new AppError(403, 'FORBIDDEN', 'Administrator access is required')
    }
    await next()
  })
}
