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
  /** Clock for the readiness-probe cache below. Overridable in tests; defaults to `Date.now`. */
  now?: () => number
}

const readinessCacheMs = 5_000

export function createApp({ env, prisma, now = Date.now }: CreateAppOptions) {
  const authContext = createAuthContext({
    db: prisma,
    supabaseJwtSecret: env.SUPABASE_JWT_SECRET,
    supabaseJwtIssuer: env.SUPABASE_JWT_ISSUER,
  })
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

  // Caches the DB probe for `readinessCacheMs` (in-process) so a flood of readiness requests -
  // this endpoint stays public behind the edge proxy, see backend/README.md - cannot multiply
  // `SELECT 1` queries against Postgres. `inFlightProbe` also collapses concurrent callers that
  // land during a cache miss onto a single query instead of one each.
  let cachedReadiness: { status: 'ok' | 'unavailable'; expiresAt: number } | undefined
  let inFlightProbe: Promise<'ok' | 'unavailable'> | undefined

  async function probeDatabase(): Promise<'ok' | 'unavailable'> {
    try {
      await prisma.$queryRaw`SELECT 1`
      return 'ok'
    } catch {
      return 'unavailable'
    }
  }

  async function checkReadiness(): Promise<'ok' | 'unavailable'> {
    const currentTime = now()
    if (cachedReadiness && cachedReadiness.expiresAt > currentTime) {
      return cachedReadiness.status
    }

    if (!inFlightProbe) {
      inFlightProbe = probeDatabase().finally(() => {
        inFlightProbe = undefined
      })
    }

    const status = await inFlightProbe
    cachedReadiness = { status, expiresAt: now() + readinessCacheMs }
    return status
  }

  app.get('/health/ready', async (c) => {
    const status = await checkReadiness()
    return c.json({ status }, status === 'ok' ? 200 : 503)
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
