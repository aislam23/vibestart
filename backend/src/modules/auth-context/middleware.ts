import type { UserRole } from '@vibestart/contracts'
import { createMiddleware } from 'hono/factory'

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
