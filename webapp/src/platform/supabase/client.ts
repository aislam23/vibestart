import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error(
    'VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY must be set. Copy webapp/.env.example to ' +
      'webapp/.env and fill them in - VITE_SUPABASE_ANON_KEY is the ANON_KEY from ' +
      'infra/supabase/.env.',
  )
}

// Sessions persist to localStorage (token-based auth, no cookies) and tokens auto-refresh before
// expiry (both defaults). `flowType: 'pkce'` and `detectSessionInUrl: true` together are what make
// the password-reset flow work: a reset link redirects to `/auth/callback?next=...` with a `?code=`
// query param, which supabase-js exchanges for a session automatically on load - see
// `platform/supabase/auth-bridge.ts` and `pages.tsx`'s `AuthCallbackPage`. PKCE over the older
// implicit flow keeps the access/refresh tokens out of the URL fragment entirely (the code is
// single-use and tied to a verifier held only in this browser), so nothing sensitive leaks via
// browser history, referrer headers, or a proxy access log.
export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    flowType: 'pkce',
    detectSessionInUrl: true,
  },
})
