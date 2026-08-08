import { createHmac, randomBytes } from 'node:crypto'

// A miniature, e2e-scoped copy of the secret-generation primitives in
// infra/supabase/generate-secrets.ts. That file is a script, not an importable module - it runs
// `main()` (which writes infra/supabase/.env) as a side effect of being loaded, so importing it
// here would either write the real dev secrets file or require refactoring it into a library just
// for this one caller. Duplicating ~20 lines of CSPRNG helpers is cheaper and keeps this throwaway
// stack's secret generation fully independent of the dev stack's.

const ALPHANUMERIC = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'

function base64url(bytes: Buffer): string {
  return bytes.toString('base64url')
}

function randomSecret(byteLength: number): string {
  return base64url(randomBytes(byteLength))
}

/** CSPRNG alphanumeric string via rejection sampling (no modulo bias). */
function randomAlphanumeric(length: number): string {
  const cutoff = 256 - (256 % ALPHANUMERIC.length)
  const chars: string[] = []
  while (chars.length < length) {
    const byte = randomBytes(1)[0]
    if (byte < cutoff) chars.push(ALPHANUMERIC[byte % ALPHANUMERIC.length])
  }
  return chars.join('')
}

/** Signs a minimal Supabase-style API key JWT: HS256, claims {"role", "iss": "supabase", "iat",
 * "exp"} - same claim shape generate-secrets.ts uses for the dev stack's ANON_KEY/SERVICE_ROLE_KEY. */
function signApiKeyJwt(role: 'anon' | 'service_role', jwtSecret: string): string {
  const nowSeconds = Math.floor(Date.now() / 1000)
  const oneDay = 24 * 60 * 60

  const header = { alg: 'HS256', typ: 'JWT' }
  const payload = { role, iss: 'supabase', iat: nowSeconds, exp: nowSeconds + oneDay }

  const signingInput = `${base64url(Buffer.from(JSON.stringify(header)))}.${base64url(
    Buffer.from(JSON.stringify(payload)),
  )}`
  const signature = createHmac('sha256', jwtSecret).update(signingInput).digest()

  return `${signingInput}.${base64url(signature)}`
}

export type E2eSecrets = {
  anonKey: string
  backendRuntimePassword: string
  dashboardPassword: string
  jwtSecret: string
  pgMetaCryptoKey: string
  postgresPassword: string
  realtimeDbEncKey: string
  secretKeyBase: string
  serviceRoleKey: string
}

/** Generates a fresh, throwaway secret set for one e2e run. Never persisted anywhere but the
 * gitignored scratch files global-setup.ts/global-teardown.ts manage (see env.ts). */
export function generateE2eSecrets(): E2eSecrets {
  const jwtSecret = randomSecret(32) // 43 chars, well over Supabase's 32-char minimum

  return {
    postgresPassword: randomSecret(24),
    jwtSecret,
    anonKey: signApiKeyJwt('anon', jwtSecret),
    serviceRoleKey: signApiKeyJwt('service_role', jwtSecret),
    dashboardPassword: randomSecret(18),
    // Realtime requires exactly 16 characters; unused here (Realtime is never started for e2e)
    // but generated for parity so the scratch .env stays valid if that ever changes.
    realtimeDbEncKey: randomAlphanumeric(16),
    secretKeyBase: randomSecret(48),
    pgMetaCryptoKey: randomSecret(24),
    backendRuntimePassword: randomSecret(24),
  }
}
