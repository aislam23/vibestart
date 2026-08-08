# Install Checklist

This file is the intake record for this repository. The installing agent fills it in during
first-run setup and keeps it current afterwards.

**For the agent:** ask the questions below in the user's language, in product terms, and write the
answers into this file as you go. Do not start feature work until everything through *First-version
capabilities* is answered. Never ask the user anything under *Decided by the agent* — make those
calls yourself and explain them in product terms.

**For the product owner:** this is the record of what was decided about your project. If something
here is wrong, say so — the agent treats this file as the source of truth for what your product
needs.

Answer cells hold `_unanswered_` until the question is asked, and `n/a` when the question cannot
apply to this project.

**When working on vibestart itself** (not installing it for a project), there is nothing to
record: leave every answer cell at `_unanswered_` and every checkbox unchecked — those would
otherwise ship to each future install. The capability ledger is the exception: it always describes
the current branch, so keep it current when template work adds or removes a capability.

**Install status:** `not started`
<!-- Set to: not started | in progress | completed YYYY-MM-DD -->

---

## 1. Project identity

| Question | Answer |
| --- | --- |
| New project from this template, or work on vibestart itself? | _unanswered_ |
| Project name / slug | _unanswered_ |
| Your own GitHub repository URL, if you have one | _unanswered_ |

If no GitHub destination is chosen, the repository is left without `origin` and publishing stays
unconfigured. The template remote is detached during setup unless this checkout is explicitly for
improving the template — see `AGENTS.md`, "Git and remote policy".

## 2. Product

| Question | Answer |
| --- | --- |
| What product do you want to build first? | _unanswered_ |
| What is the first user journey that must work end to end? | _unanswered_ |

## 3. Active surfaces

Mark what is active now, and set the install status to `in progress` as soon as this section is
answered. From then on, everything unmarked is deferred and must be left alone: no features, no
setup, no test flows.

- [ ] `backend` — API, database, auth
- [ ] `webapp` — browser screens behind sign-in (no SEO)
- [ ] `website` — public pages that must rank in search or preview when shared

**There is no mobile branch in vibestart.** Unlike some template lineages, this repository ships
only these three surfaces plus `packages/contracts`. If the product needs a native/Expo app, that
is new work against `packages/contracts`, not an existing branch to switch to.

| Question | Answer |
| --- | --- |
| Why the unmarked surfaces are deferred, if it needs explaining | _unanswered_ |

The split between `webapp` and `website` is the agent's call, not the user's — see the root
`README.md`, "webapp vs. website: which surface does a feature belong to?".

## 4. First-version capabilities

Ask about product needs, not implementations. Mark what the first version actually needs, then
fill the row below even when nothing was ticked, so a later session can tell "asked, and the answer
was no" from "not asked yet".

- [ ] Accounts / sign-in
- [ ] Saved data that survives a restart
- [ ] File, image, or media uploads → also answer *Files, images, and media*
- [ ] Paid subscriptions or one-off payments → also answer *Payments*
- [ ] Admin tools or roles
- [ ] External integrations (which: _unanswered_)
- [ ] Real-time updates, presence, or collaboration

| Question | Answer |
| --- | --- |
| What the first version explicitly should NOT do (write "nothing ruled out" if that is the answer) | _unanswered_ |

## 5. Files, images, and media

Answer these only when uploads are active above; otherwise mark the rows `n/a`. Keep the section
either way — `docs/SUPABASE.md` sends the agent here when uploads are added later.

| Question | Answer |
| --- | --- |
| What do users upload? | _unanswered_ |
| Public, private, shared with selected people, or mixed? | _unanswered_ |
| Who can upload, view, replace, and delete? | _unanswered_ |
| Maximum file size and allowed file types | _unanswered_ |
| Do images need thumbnails, resizing, format conversion, compression, cropping, or moderation? | _unanswered_ |
| How long do files live after the owning record is deleted? | _unanswered_ |

Storage is Supabase Storage (`infra/supabase`'s `storage`/`imgproxy` services), backed by either
local disk or an S3-compatible bucket — see `docs/SUPABASE.md` and *Deployment* below for the S3
question. No bucket, RLS policy, route, or UI exists yet; building the feature is what turns this
capability from `available` to `included` in the ledger below.

## 6. Payments

Answer these only when payments are active above; otherwise mark the rows `n/a`.

| Question | Answer |
| --- | --- |
| What exactly do users pay for? | _unanswered_ |
| Recurring subscription, one-off purchase, or both? | _unanswered_ |
| What stops working when someone does not pay? | _unanswered_ |

vibestart ships **no payments code at all** — no Stripe integration, no billing module, no
entitlement checks. If this project needs payments, it is built from scratch as a new backend
module (`backend/src/modules/billing/` or similar, following the same transport/application/domain
boundaries as `users`) plus contracts in `packages/contracts` and UI in `webapp`. Record the design
here once it exists; never scaffold it on a guess.

## 7. Deployment

| Question | Answer |
| --- | --- |
| Is deployment needed now, or local-only for the moment? | _unanswered_ |
| Domain(s) — app, site, API, and the Supabase/Studio domain | _unanswered_ |
| S3-compatible provider for Supabase Storage and for backups (can be the same bucket family, but use separate buckets — see `infra/backup/README.md`) | _unanswered_ |
| SMTP provider for production auth email (password reset, email confirmation) | _unanswered_ |
| Which surfaces are released first | _unanswered_ |

**Hosting is one fixed model, not a choice.** vibestart deploys to exactly one target: a single VPS
running Docker Compose (self-hosted Supabase + the backend + Caddy edge + restic backups). There is
no DigitalOcean App Platform, Yandex Cloud, or other managed-cloud path to choose between — see
`docs/DEPLOYMENT.md` for the full runbook. Local development never requires any of the answers
above; they only matter once deployment starts.

Deployment is often deferred at install time, which leaves these rows `_unanswered_`. When the user
later asks to deploy, ask the unanswered questions then, write the answers back here, and follow
`docs/DEPLOYMENT.md`.

## 8. Decided by the agent — do not ask the user

The user is a product owner, not an engineer. These are engineering decisions the agent owns,
makes, and explains only in product terms:

- Which browser surface a feature belongs to (`website` for SEO/public, `webapp` for behind-login).
- Module boundaries and layering inside `backend`/`webapp` — see `docs/ARCHITECTURE.md`.
- Which of the three background-job runners (`cron.ts`, `scheduler.ts`, `worker.ts`) a new
  scheduled job uses — see `backend/README.md`, "Background jobs".
- `STORAGE_BACKEND=file` vs `s3` for Supabase Storage, and when to switch (recommend `s3` before
  any production launch, since switching after objects exist needs a manual migration).
- Test boundaries: E2E for important user journeys, integration for API/auth/persistence, unit for
  pure rules — see `docs/TESTING.md`.
- Libraries, file layout, naming, refactors, and validation scope.

## 9. Capability ledger

What this project actually contains. The agent updates it whenever a capability is added or
removed. Every row carries exactly one state:

- `included` — present and expected to work.
- `available` — the underlying piece exists (a stack, a service, an empty registry) but the
  product-facing feature is not usable yet; the note says exactly what's missing.
- `absent` — not part of this project. Build it only after the product owner asks.
- `removed` — deliberately deleted during setup. **Do not re-add it.**

A capability with no row is `absent` by default.

| Capability | State | Note |
| --- | --- | --- |
| Auth (email + password) | included | Supabase Auth (GoTrue), self-hosted. See `AGENTS.md`, "Auth model". |
| Admin roles | included | `profiles.role` (`user`/`admin`) in the backend's own database, admin API + UI both present (`GET/PATCH /api/admin/users`, `webapp`'s admin surface). |
| Password reset email delivery | available | The flow is fully built (`supabase.auth.resetPasswordForEmail`, `/reset-password`); local dev works with autoconfirm and no SMTP. Production needs real SMTP configured on GoTrue (`infra/supabase/.env`) before reset emails actually send. |
| File/media storage | available | Supabase Storage + imgproxy ship in the stack (`infra/supabase`), local-disk by default. No bucket, RLS policy, backend route, or UI exists yet — see section 5 above. |
| Backups | included | restic → S3, scheduled, verified, with retention rotation (`infra/backup`). Needs S3 credentials and (recommended) a heartbeat monitor configured before it's actually protecting anything — see `docs/BACKUPS.md`. |
| Payments / subscriptions | absent | No payment code anywhere in this template. See section 6 above. |
| Realtime | available | Supabase Realtime ships in the stack (`infra/supabase`'s `realtime` service, routed through Kong). No product code subscribes to it yet. |
| Background jobs | available | Registry (`backend/src/jobs.ts`) and all three runners exist and are tested, but the registry itself is empty — no job ships by default. |
| Email / SMTP | available | GoTrue (Supabase Auth) sends auth email once SMTP is configured in `infra/supabase/.env`; there is no general-purpose transactional-email sending outside of auth flows. |
| Social sign-in (OAuth providers) | absent | GoTrue supports it, but no provider is configured or wired into `webapp`. |
| Push notifications | absent | No mobile surface, no push code. |

## 10. Environment checks

Verified by the agent during setup, not asked.

- [ ] `docker compose version` and `docker info` succeed
- [ ] `git remote -v` inspected; template remote detached unless contributing to the template
- [ ] `bun install` succeeds; `infra/supabase/.env` generated with `make secrets` (never hand-copy `.env.example` placeholders into a real deployment)
- [ ] `backend/.env` and `webapp/.env` created from their `.env.example` files and filled from `infra/supabase/.env`
- [ ] Smallest meaningful validation run for the active surfaces (`bun run test`, and `bun run test:backend:integration`/`bun run e2e:webapp` if Docker is available)

## 11. After setup

- [ ] Durable answers above filled in, install status set to `completed YYYY-MM-DD`
- [ ] Validation scope recorded for this project (which suites run before a change is called done): _unanswered_
- [ ] Project identifiers renamed away from `vibestart` (`package.json` names, `@vibestart/*` workspace references, Docker `container_name`/network names, GHCR image names in `.github/workflows/deploy.yml`), `bun.lock` regenerated — `deploy.yml`'s health/log steps resolve the backend container via `docker compose ps -q backend` (the compose **service** name), not the literal `container_name`, so renaming `container_name: vibestart-backend` in `infra/app/docker-compose.yml` does not break the deploy healthcheck; only `infra/edge/Caddyfile`'s `reverse_proxy backend:3000` (which resolves the compose **service** name on the `app_edge` network, also unaffected by a `container_name` rename) needs no change either
- [ ] Deferred-surface notes added to the READMEs of surfaces that are not active
- [ ] `Bootstrap-Only Instructions` blocks deleted from `AGENTS.md` and `CLAUDE.md`
- [ ] Local URLs, commands run, and anything the user must authorize manually (DNS, SMTP, S3 credentials, GitHub Actions secrets) reported back to the user

`README.md`, `AGENTS.md`, and `CLAUDE.md` route agents into this file. Cross-reference sections by
name rather than by number so renumbering stays harmless.
