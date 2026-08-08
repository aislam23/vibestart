import { OpenAPIHono } from '@hono/zod-openapi'
import { cors } from 'hono/cors'
import { secureHeaders } from 'hono/secure-headers'

import type { DbClient } from './db'
import type { AppEnv } from './env'
import { errorResponse, handleError, validationErrorHook } from './http/errors'
import { createAuthContext } from './modules/auth-context'
import type { AuthHttpEnv } from './modules/auth-context'
import { createUsersModule } from './modules/users'

type CreateAppOptions = {
  env: AppEnv
  prisma: DbClient
}

export function createApp({ env, prisma }: CreateAppOptions) {
  const authContext = createAuthContext({ db: prisma, supabaseJwtSecret: env.SUPABASE_JWT_SECRET })
  const users = createUsersModule({
    db: prisma,
    env,
    requireAdmin: authContext.requireAdmin,
    requireAuth: authContext.requireAuth,
  })

  const app = new OpenAPIHono<AuthHttpEnv>({
    defaultHook: validationErrorHook,
  })
  app.openAPIRegistry.registerComponent('securitySchemes', 'BearerAuth', {
    type: 'http',
    scheme: 'bearer',
    bearerFormat: 'JWT',
  })

  app.use(secureHeaders())
  app.use(
    '*',
    cors({
      origin: (origin) => {
        if (!origin) return env.CORS_ORIGINS[0] ?? null
        return env.CORS_ORIGINS.includes(origin) ? origin : null
      },
      allowHeaders: ['Content-Type', 'Authorization'],
      allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      // Supabase Auth issues bearer tokens, not cookies - the backend never needs credentialed
      // (cookie-carrying) cross-origin requests.
      credentials: false,
      maxAge: 600,
    }),
  )

  app.get('/', (c) => {
    return c.json({
      name: 'vibestart backend',
      status: 'ok',
    })
  })

  app.get('/health/live', (c) => {
    return c.json({ status: 'ok' })
  })

  app.get('/health/ready', async (c) => {
    try {
      await prisma.$queryRaw`SELECT 1`
      return c.json({ status: 'ok' }, 200)
    } catch {
      return c.json({ status: 'unavailable' }, 503)
    }
  })

  app.route('/api/users', users.userRoutes)
  app.route('/api/admin', users.adminRoutes)

  app.doc('/openapi.json', {
    openapi: '3.0.0',
    info: {
      title: 'vibestart backend API',
      version: '1.0.0',
    },
  })

  app.notFound((c) => c.json(errorResponse('NOT_FOUND', 'Route not found'), 404))
  app.onError(handleError)

  return app
}

export type AppType = ReturnType<typeof createApp>
