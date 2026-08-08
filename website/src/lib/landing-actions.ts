// Placeholder until this project has its own repository - set PUBLIC_REPO_URL to the real
// `https://github.com/<owner>/<repo>` URL once it exists (see .github/workflows/README.md for the
// production build's PUBLIC_REPO_URL variable). astro.config.mjs's production build gate fails the
// build if PUBLIC_SITE_ENV=production and this is still the unmodified placeholder - see
// astro.config.mjs, "Production build gate".
export const TEMPLATE_PLACEHOLDER_URL = 'https://github.com/your-org/vibestart'

export const TEMPLATE_ACTION = {
  href: import.meta.env.PUBLIC_REPO_URL?.trim() || TEMPLATE_PLACEHOLDER_URL,
  label: 'View the template on GitHub',
} as const

function isProductionBuild(): boolean {
  return import.meta.env.PUBLIC_SITE_ENV === 'production'
}

/**
 * https:// is always allowed. A bare `http://localhost`/`http://127.0.0.1` is additionally allowed
 * outside of a production build, so pointing PUBLIC_WEBAPP_URL at a local dev webapp during
 * `astro dev`/local testing doesn't need a throwaway TLS cert. Everything else (a plain http://
 * production host, and non-http(s) schemes like `javascript:`/`data:`) is rejected - this is a
 * value that gets emitted directly as an `<a href>`, so an unexpected scheme here is a real
 * injection surface, not just a cosmetic bug.
 */
function isAllowedWebappUrl(url: URL): boolean {
  if (url.protocol === 'https:') return true
  if (isProductionBuild()) return false
  return url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1')
}

export function getSecondaryAction(publicWebappUrl?: string) {
  const webappUrl = publicWebappUrl?.trim()

  if (!webappUrl) {
    return { href: '#process', label: 'See how it works' }
  }

  let parsed: URL
  try {
    parsed = new URL(webappUrl)
  } catch {
    return { href: '#process', label: 'See how it works' }
  }

  if (!isAllowedWebappUrl(parsed)) {
    if (isProductionBuild()) {
      throw new Error(
        `PUBLIC_WEBAPP_URL must be an https:// URL in production (PUBLIC_SITE_ENV=production), got: ` +
          `"${webappUrl}". Fix the PUBLIC_WEBAPP_URL variable, or unset it to fall back to the local ` +
          `"See how it works" anchor.`,
      )
    }
    return { href: '#process', label: 'See how it works' }
  }

  return { href: webappUrl, label: 'Open the web app' }
}
