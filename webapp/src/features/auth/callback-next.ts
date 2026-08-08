/**
 * Where `/auth/callback?next=...` is allowed to continue to once a session lands. A closed
 * allowlist, not a general "is this a local path" parser: `next` comes straight off the URL of a
 * link that was, at some point, emailed out (or generated via the admin API in e2e) - an attacker
 * who can get a target to click a crafted `/auth/callback?next=...` link controls this value
 * completely, so anything short of an exact match against known-safe in-app destinations risks an
 * open redirect (`next=https://evil.example` or `next=//evil.example`) once a session exists.
 *
 * The only real caller today is `requestPasswordReset` (`provider.tsx`), which always sets
 * `next=/reset-password`.
 */
const allowedNextPaths = new Set<string>(['/reset-password'])

/** Returns `value` if it is on the allowlist, otherwise `/` - never echoes an unrecognized value
 * back into a redirect. */
export function safeNextPath(value: string | undefined): string {
  return value !== undefined && allowedNextPaths.has(value) ? value : '/'
}
