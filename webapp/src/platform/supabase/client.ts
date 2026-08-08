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

// Default config: sessions persist to localStorage (token-based auth, no cookies), tokens
// auto-refresh before expiry, and the client parses recovery/confirmation tokens out of the
// URL on load (`detectSessionInUrl`), which is what makes the password-reset flow work.
export const supabase = createClient(supabaseUrl, supabaseAnonKey)
