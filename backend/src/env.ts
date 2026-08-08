// Modified from the Vibe Coding Template (https://github.com/di-sukharev/vibe), Apache-2.0. See NOTICE.
import { z } from 'zod'

const booleanStringSchema = z
  .enum(['true', 'false'])
  .default('false')
  .transform((value) => value === 'true')

const knownWeakSupabaseJwtSecrets = new Set(['replace_with_supabase_jwt_secret'])

const optionalStringSchema = z.preprocess((value) => {
  if (typeof value !== 'string') return value
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}, z.string().min(1).optional())

const optionalHttpHeaderNameSchema = z.preprocess((value) => {
  if (typeof value !== 'string') return value
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed.toLowerCase()
}, z.string().regex(/^[a-z0-9!#$%&'*+.^_`|~-]+$/).optional())

const envSchema = z
  .object({
    NODE_ENV: z.string().optional(),
    PORT: z.coerce.number().int().positive().default(3000),
    DATABASE_URL: z.string().min(1),
    // Self-hosted Supabase (infra/supabase). Auth (signup/login/tokens) happens
    // between the browser and GoTrue directly - the backend only verifies the
    // JWTs GoTrue issues and, optionally, calls Supabase's admin API.
    SUPABASE_URL: z.string().url(),
    SUPABASE_JWT_SECRET: z.string().min(32),
    SERVICE_ROLE_KEY: optionalStringSchema,
    CORS_ORIGINS: z
      .string()
      .default('http://localhost:5173,http://localhost:8081,http://localhost:19006')
      .transform((value) =>
        value
          .split(',')
          .map((origin) => origin.trim())
          .filter(Boolean),
      ),
    SHUTDOWN_GRACE_SECONDS: z.coerce.number().int().positive().max(60).default(20),
    // Budget for the admin users-directory read endpoint (GET /api/admin/users), keyed by
    // administrator id in src/modules/users. Independent of any other rate limit the backend adds.
    ADMIN_USERS_READ_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(120),
    ADMIN_USERS_READ_RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().positive().default(60),
    TRUST_PROXY: booleanStringSchema,
    TRUSTED_PROXY_CLIENT_IP_HEADER: optionalHttpHeaderNameSchema,
    TRUSTED_PROXY_CLIENT_IP_POSITION: z.enum(['first', 'last']).optional(),
  })
  .superRefine((env, ctx) => {
    validateSupabaseJwtSecret(env, ctx)
    validateCorsOrigins(env, ctx)
    validateTrustedProxy(env, ctx)
  })

export type AppEnv = z.infer<typeof envSchema>

export function loadEnv(source: Record<string, string | undefined>) {
  return envSchema.parse(source)
}

function validateSupabaseJwtSecret(env: z.infer<typeof envSchema>, ctx: z.RefinementCtx) {
  if (env.NODE_ENV !== 'production') return

  if (isWeakSecret(env.SUPABASE_JWT_SECRET)) {
    ctx.addIssue({
      code: 'custom',
      path: ['SUPABASE_JWT_SECRET'],
      message: 'SUPABASE_JWT_SECRET must be a non-placeholder random secret in production',
    })
  }
}

function isWeakSecret(secret: string) {
  const normalized = secret.trim().toLowerCase()
  return (
    normalized.length === 0 ||
    knownWeakSupabaseJwtSecrets.has(normalized) ||
    new Set(normalized).size === 1
  )
}

function validateTrustedProxy(env: z.infer<typeof envSchema>, ctx: z.RefinementCtx) {
  if (env.TRUST_PROXY && !env.TRUSTED_PROXY_CLIENT_IP_HEADER) {
    ctx.addIssue({
      code: 'custom',
      path: ['TRUSTED_PROXY_CLIENT_IP_HEADER'],
      message: 'TRUSTED_PROXY_CLIENT_IP_HEADER is required when TRUST_PROXY=true',
    })
  }

  if (env.TRUSTED_PROXY_CLIENT_IP_POSITION && !env.TRUSTED_PROXY_CLIENT_IP_HEADER) {
    ctx.addIssue({
      code: 'custom',
      path: ['TRUSTED_PROXY_CLIENT_IP_POSITION'],
      message: 'TRUSTED_PROXY_CLIENT_IP_POSITION requires TRUSTED_PROXY_CLIENT_IP_HEADER',
    })
  }
}

function validateCorsOrigins(env: z.infer<typeof envSchema>, ctx: z.RefinementCtx) {
  if (env.CORS_ORIGINS.length === 0) {
    ctx.addIssue({
      code: 'custom',
      path: ['CORS_ORIGINS'],
      message: 'CORS_ORIGINS must contain at least one allowed browser origin',
    })
    return
  }

  for (const origin of env.CORS_ORIGINS) {
    if (origin === '*') {
      ctx.addIssue({
        code: 'custom',
        path: ['CORS_ORIGINS'],
        message: 'CORS_ORIGINS must not use wildcard origins',
      })
      continue
    }

    let url: URL
    try {
      url = new URL(origin)
    } catch {
      ctx.addIssue({
        code: 'custom',
        path: ['CORS_ORIGINS'],
        message: `CORS_ORIGINS contains an invalid URL: ${origin}`,
      })
      continue
    }

    if (!['http:', 'https:'].includes(url.protocol)) {
      ctx.addIssue({
        code: 'custom',
        path: ['CORS_ORIGINS'],
        message: `CORS_ORIGINS must use http or https origins: ${origin}`,
      })
    }

    if (url.origin !== origin) {
      ctx.addIssue({
        code: 'custom',
        path: ['CORS_ORIGINS'],
        message: `CORS_ORIGINS must contain origins only, not paths: ${origin}`,
      })
    }

    if (env.NODE_ENV === 'production' && url.protocol !== 'https:') {
      ctx.addIssue({
        code: 'custom',
        path: ['CORS_ORIGINS'],
        message: `CORS_ORIGINS must use HTTPS in production: ${origin}`,
      })
    }
  }
}
