import {
  apiErrorSchema,
  meResponseSchema,
  updateProfileRequestSchema,
  updateProfileResponseSchema,
} from '@vibestart/contracts'
import { createRoute, OpenAPIHono } from '@hono/zod-openapi'
import type { MiddlewareHandler } from 'hono'

import { validationErrorHook } from '../../../http/errors'
import type { AuthHttpEnv } from '../../auth-context'
import type { UsersService } from '../application/users-service'

const errorContent = {
  'application/json': {
    schema: apiErrorSchema,
  },
}

const bearerSecurity = [{ BearerAuth: [] }]

const meRoute = createRoute({
  method: 'get',
  path: '/me',
  security: bearerSecurity,
  responses: {
    200: {
      content: { 'application/json': { schema: meResponseSchema } },
      description: 'Current user',
    },
    401: { content: errorContent, description: 'Authentication required' },
  },
})

const updateProfileRoute = createRoute({
  method: 'patch',
  path: '/me',
  security: bearerSecurity,
  request: {
    body: {
      content: {
        'application/json': {
          schema: updateProfileRequestSchema,
        },
      },
    },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: updateProfileResponseSchema } },
      description: 'Updated current user profile',
    },
    400: { content: errorContent, description: 'Invalid payload' },
    401: { content: errorContent, description: 'Authentication required' },
  },
})

type CreateUsersRoutesOptions = {
  requireAuth: MiddlewareHandler<AuthHttpEnv>
  service: UsersService
}

export function createUsersRoutes({ requireAuth, service }: CreateUsersRoutesOptions) {
  const routes = new OpenAPIHono<AuthHttpEnv>({ defaultHook: validationErrorHook })

  routes.use('*', requireAuth)
  routes.openapi(meRoute, (c) => c.json(service.me(c.var.user), 200))
  routes.openapi(updateProfileRoute, async (c) => {
    const result = await service.updateProfile(c.var.user, c.req.valid('json'))
    return c.json(result, 200)
  })

  return routes
}
