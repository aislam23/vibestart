// @ts-check
import { defineConfig } from 'astro/config';

import react from '@astrojs/react';
import tailwindcss from '@tailwindcss/vite';

// https://astro.build/config
//
// Default rendering is static (SSG): every page prerenders to HTML and the
// build emits a plain static site in `website/dist`, bind-mounted read-only
// by infra/edge's Caddy - see docs/DEPLOYMENT.md and AGENTS.md, "Hosting
// reality" (one VPS, Docker Compose - this template has exactly one
// deployment target, not a choice of static hosts/CDNs).
//
// SSR upgrade path (do this only when a route needs request-specific server
// rendering, e.g. live search or a personalized view, where stale HTML is
// unacceptable):
//   1. Install a Node adapter that matches THIS Astro version:
//        bun add @astrojs/node --cwd website
//      (verify the resolved version's `astro` peer range covers the installed
//       Astro; mismatched majors fail the build).
//   2. Add the adapter here: `adapter: node({ mode: 'standalone' })`, keep
//      `output: 'static'`. With an adapter, `astro build` emits `dist/client`
//      (static assets/HTML) plus `dist/server` (runtime entry), so the static
//      output dir becomes `website/dist/client` - infra/edge's Caddyfile and
//      docker-compose.yml bind mount would both need updating to match.
//   3. Opt a single route into SSR with `export const prerender = false`.
//   4. This surface would then need to run as a container (a new
//      infra/app-style compose service), not a static bind mount - SSR
//      routes need the Node server running.

// Production build gate: fails `astro build` loudly, before it ever writes dist/, if
// PUBLIC_SITE_ENV=production and the template's own repo-URL placeholder was never replaced with
// this project's real one. Duplicated as a plain string (not imported from
// src/lib/landing-actions.ts's TEMPLATE_PLACEHOLDER_URL) deliberately - this file runs directly
// under Astro's Node-based config loader, outside the Vite pipeline that makes
// `import.meta.env.PUBLIC_*` work inside src/, so importing that module here would evaluate its
// top-level `import.meta.env.PUBLIC_REPO_URL` read against an environment Vite never populated.
// Keep this string in sync with src/lib/landing-actions.ts's TEMPLATE_PLACEHOLDER_URL.
//
// PUBLIC_SITE_ENV is only set to "production" by .github/workflows/deploy.yml's website build
// step - a plain local `bun run build`/`bun run test` (including in THIS repo, which still has the
// placeholder) stays unaffected, so the template's own CI keeps passing.
const TEMPLATE_PLACEHOLDER_URL = 'https://github.com/your-org/vibestart';

if (process.env.PUBLIC_SITE_ENV === 'production') {
  const repoUrl = process.env.PUBLIC_REPO_URL?.trim();

  if (!repoUrl || repoUrl === TEMPLATE_PLACEHOLDER_URL) {
    throw new Error(
      'PUBLIC_REPO_URL is required for a production build (PUBLIC_SITE_ENV=production) - the ' +
        `template placeholder (${TEMPLATE_PLACEHOLDER_URL}) must not ship to a real deploy. Set ` +
        "PUBLIC_REPO_URL to this project's own GitHub repository URL before deploying.",
    );
  }
}

export default defineConfig({
  integrations: [react()],
  vite: {
    plugins: [tailwindcss()]
  }
});
