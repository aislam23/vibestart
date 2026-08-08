/**
 * Whether `AuthProvider` should still report `isBootstrapping: true` to the rest of the app.
 *
 * Stays true until the session itself is known, AND - once a session exists - until that
 * session's very first `/me` fetch has actually resolved. Without the second half, a route guard
 * would see `isBootstrapping: false` with `user: null` for one tick while `/me` is still in
 * flight, which pages.tsx's guards (e.g. `WorkspaceRoute`) read as "signed out": a login-form
 * flash for a guest-only route, or an already-authenticated admin bouncing to `/login` before
 * `/me` lands.
 */
export function isAuthBootstrapping({
  hasSession,
  isMeQueryLoading,
  isSessionBootstrapping,
}: {
  isSessionBootstrapping: boolean
  hasSession: boolean
  /** `useCurrentUserQuery(...).isLoading` - true only for the initial fetch (no cached data yet
   * AND currently fetching), never for a background refetch of already-cached data. */
  isMeQueryLoading: boolean
}): boolean {
  return isSessionBootstrapping || (hasSession && isMeQueryLoading)
}
