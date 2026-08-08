import type { AuthChangeEvent, Session } from '@supabase/supabase-js'

export type AuthBridgeListener = (event: AuthChangeEvent, session: Session | null) => void

export type AuthBridge = {
  /**
   * Subscribes to every auth event fired since {@link createAuthBridge} ran, replaying anything
   * buffered before this call and then forwarding events live. There is only ever one real
   * subscriber in this app (`AuthProvider`) - a second call simply replaces the first, and the
   * returned function unsubscribes it.
   */
  subscribe: (listener: AuthBridgeListener) => () => void
}

type MinimalAuthClient = {
  auth: {
    onAuthStateChange: (
      callback: (event: AuthChangeEvent, session: Session | null) => void,
    ) => { data: { subscription: { unsubscribe: () => void } } }
  }
}

/**
 * Wraps `client.auth.onAuthStateChange` with a single, permanent subscription registered the
 * moment this function runs, and buffers every event fired before {@link AuthBridge.subscribe} is
 * first called.
 *
 * Exists because `AuthProvider` only subscribes from inside a `useEffect`, which commits strictly
 * after React's first render - late enough that supabase-js can already have fired
 * `INITIAL_SESSION` (and, when the app was opened from a password-recovery or magic-link
 * redirect, `PASSWORD_RECOVERY`) with nobody listening yet. `platform/supabase/index.ts` calls
 * this once, at module init - before React ever mounts - so those events are captured no matter
 * how long the first render takes.
 */
export function createAuthBridge(client: MinimalAuthClient): AuthBridge {
  const buffered: Array<{ event: AuthChangeEvent; session: Session | null }> = []
  let listener: AuthBridgeListener | null = null

  client.auth.onAuthStateChange((event, session) => {
    if (listener) {
      listener(event, session)
    } else {
      buffered.push({ event, session })
    }
  })

  return {
    subscribe(nextListener) {
      listener = nextListener
      if (buffered.length > 0) {
        const queued = buffered.splice(0, buffered.length)
        for (const { event, session } of queued) nextListener(event, session)
      }
      return () => {
        if (listener === nextListener) listener = null
      }
    },
  }
}
