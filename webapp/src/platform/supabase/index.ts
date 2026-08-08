import { createAuthBridge } from './auth-bridge'
import { supabase } from './client'

export { supabase } from './client'
export { createAuthBridge } from './auth-bridge'
export type { AuthBridge, AuthBridgeListener } from './auth-bridge'

// The one production instance, created at module init - see auth-bridge.ts's doc comment for why
// this has to happen before React mounts rather than inside AuthProvider's own effect. Tests
// construct their own bridge via `createAuthBridge` against a fake client instead of importing
// this singleton, so they never need real Supabase env vars.
export const authBridge = createAuthBridge(supabase)
