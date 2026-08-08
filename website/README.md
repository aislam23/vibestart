# Website

The website workspace is a separate Astro project for public, SEO-facing surfaces: the landing page, and any future marketing/content pages. It is the SSG-first counterpart to the CSR `webapp` (which lives behind auth and needs no SEO). Keep it independent from authenticated browser-app workflows unless a product need explicitly requires shared API data.

## Stack

- Astro (static SSG by default; SSR-ready per route)
- Tailwind CSS 4 through the official Vite plugin
- shadcn/ui registry rendered through React on the server by default
- React Three Fiber for the isolated, decorative hero visual
- TypeScript
- Vite through Astro

The landing page is composed from small Astro-owned sections under `src/components/landing`.
The complete generated shadcn registry lives under `src/components/ui`; landing sections use only
the primitives they need and keep product content in static HTML. The hero's R3F scene is the one
intentional client-only enhancement and remains decorative; it must not own SEO-critical copy. Keep
product copy and composition in the landing components, global tokens in `src/styles/global.css`,
and page metadata in the layout/page.

The landing copy shipped here (`src/components/landing/*`, `src/lib/landing-actions.ts`,
`src/pages/index.astro`) is deliberately generic, placeholder marketing copy for vibestart itself,
not a real product - replace it with your own product's copy, keeping the section structure
(ids, `aria-labelledby` wiring, the single hero client island) if you want `tests/landing.test.ts`
to keep passing without also rewriting it.

## Rendering model

Astro prerenders every page to static HTML by default, so the standard build is a cheap static site in `website/dist`. No server adapter is installed by default, on purpose: the common case (a landing page, plus any future content pages) is pure static.

A route can opt into server rendering (SSR) with `export const prerender = false`. SSR is a deliberate upgrade, not the default, because it requires installing a Node adapter and deploying as a runtime service instead of a static bind mount. Keep marketing/content pages static; render only request-specific routes on demand if a future page genuinely needs one (live search, a personalized public view, or a price/inventory page where stale HTML is unacceptable).

Use this freshness ladder before making an entire page uncached or personalized SSR:

1. SSG plus rebuild/redeploy for durable content changes such as edited copy or a new page.
2. Cached on-demand/SSR routes with CDN headers such as `stale-while-revalidate` when freshness matters more than a full redeploy cycle.
3. Astro server islands for non-SEO-critical dynamic or personalized fragments, such as a signed-in header state.
4. Uncached or personalized Astro SSR only for request-specific pages where initial HTML must reflect current request data.

On-demand/SSR routes and server islands both require an Astro adapter and a runtime-capable deployment - they do not work from a static bind mount. Server islands keep the main page prerendered while rendering only a fragment on demand; they are a smaller runtime step than making the whole route SSR, not a feature of static hosting. When server islands appear on cached pages or during rolling deploys, generate a stable key with `astro create-key` and configure `ASTRO_KEY` as a secret in both build and runtime environments so old cached HTML and the current server bundle can decrypt island props consistently. Never commit it, print it, expose it as `PUBLIC_*`, or bake it into static output.

Only anonymous, public-equivalent HTML may use shared CDN caching such as `public`, `s-maxage`, or `stale-while-revalidate`. Auth-dependent or personalized routes and server islands must use `private` or `no-store`, or a deliberately supported `Vary: Cookie`/`Authorization` strategy. `ASTRO_KEY` protects island prop encryption and deploy consistency; it is not a cache privacy boundary.

SEO-critical content must be present in the initial HTML: title, description, canonical URL, Open Graph/Twitter tags, and any other indexable copy. Client islands and server islands may enhance the page, but they must not be the only source of SEO-critical content.

## Env

Build-time only - Astro inlines these into the static output, so they must be set wherever the site is *built*, not just where it runs:

| Variable | Required | Notes |
| --- | --- | --- |
| `PUBLIC_WEBSITE_URL` | no | The site's own public canonical origin, e.g. `https://example.com`. Used for `<link rel="canonical">` and `og:url` in `src/pages/index.astro`. Without it, pages omit both. |
| `PUBLIC_WEBAPP_URL` | no | The webapp's public origin, e.g. `https://app.example.com`. When set, the landing page's secondary CTA links straight to it (`src/lib/landing-actions.ts`); when unset, it falls back to a local `#process` anchor. |

Astro only exposes env vars prefixed `PUBLIC_` to `import.meta.env` in client/build output - see [Astro's env docs](https://docs.astro.build/en/guides/environment-variables/). There is no `.env.example` checked in here (only two optional, non-secret build-time vars) - set them directly in whatever builds this workspace; see `.github/workflows/deploy.yml` for how CI provides them in production.

## Commands

From the repository root:

```bash
bun run dev:website
bun run typecheck:website
bun run build:website
bun run test:website
```

From `website`:

```bash
bun run dev
bun run typecheck
bun run build
bun run test
bun run preview
```

Astro publishes pages from `src/pages`. Static assets live in `public`.

## Deployment

The build output in `website/dist` is a fully static site with no server islands or runtime-rendered routes - production deployment is a plain static file serve, not a runtime service. `infra/edge`'s Caddy stack bind-mounts `website/dist` read-only and serves it directly at `{$SITE_DOMAIN}` (see `infra/edge/docker-compose.yml` and `infra/edge/Caddyfile`) - there is no server process for this workspace in production, unlike `backend`.

`.github/workflows/deploy.yml` builds this workspace in CI (`bun run build:website`, with `PUBLIC_WEBSITE_URL`/`PUBLIC_WEBAPP_URL` supplied as GitHub Actions variables - see `.github/workflows/README.md`) and rsyncs `website/dist` to the path `infra/edge` expects on the VPS. Rebuild and redeploy after either URL changes - they're baked in at build time, not read at runtime.

### SSR upgrade path

Do this only when a route actually needs server rendering. Steps (also summarized in `astro.config.mjs`):

1. Install a Node adapter that matches the installed Astro version: `bun add @astrojs/node --cwd website`. Verify the resolved version's `astro` peer range covers the installed Astro; a major mismatch fails the build.
2. Register it in `astro.config.mjs` as `adapter: node({ mode: 'standalone' })` and keep `output: 'static'`. With an adapter, `astro build` emits `dist/client` (static assets/HTML) plus `dist/server` (runtime entry), so the static output dir becomes `website/dist/client`.
3. Mark the dynamic route with `export const prerender = false`.
4. Deploy this surface as its own service in `infra/app/docker-compose.yml` (a runtime container joining the `edge` network, the same pattern `backend` already uses - see `infra/app/README.md`) instead of a static bind mount, since SSR routes need the Node server at runtime. `infra/edge/Caddyfile`'s `{$SITE_DOMAIN}` block would then need `reverse_proxy` instead of `root`/`file_server`.

Keep dynamic pages fresh with HTTP cache headers (`Cache-Control`, `stale-while-revalidate`) once the website is deployed as a runtime service. Per-page incremental static regeneration (ISR) is not part of this static-bind-mount deployment path; use rebuilds or CDN/runtime cache freshness instead.

## Practice

Keep website-specific UI and content in this workspace. Do not duplicate authenticated browser-app flows from `webapp`. Auth inside `website` is acceptable only for small public-site needs, such as a logged-in header state. Full account, admin, and dashboard workflows stay in `webapp` unless they have a concrete SEO requirement.

If the website starts reading API data or shared DTOs, add `@vibestart/contracts` intentionally and validate the producer/consumer path. Add `@astrojs/react` (already installed) only when a page needs interactive React islands beyond the existing hero.

Astro remains the default here because it is content-first, static-first, low-JS by default, and easy for agents to reason about as the SEO surface.

## Current Upstream Documentation

For Astro, routing, content, on-demand rendering, adapters, build, or deployment questions, consult the current upstream documentation linked here first. This README describes this workspace's conventions; upstream docs are authoritative for Astro behavior.

- [Astro docs](https://docs.astro.build/en/getting-started/)
- [Astro project structure](https://docs.astro.build/en/basics/project-structure/)
- [Astro pages and routing](https://docs.astro.build/en/basics/astro-pages/)
- [Astro on-demand rendering](https://docs.astro.build/en/guides/on-demand-rendering/)
- [Astro Node adapter](https://docs.astro.build/en/guides/integrations-guide/node/)
- [Astro deployment guides](https://docs.astro.build/en/guides/deploy/)
- [TypeScript docs](https://www.typescriptlang.org/docs/)
- [Vite guide](https://vite.dev/guide/)
