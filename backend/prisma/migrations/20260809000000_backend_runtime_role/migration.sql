-- Least-privileged runtime role for the backend application (`DATABASE_URL` in production, once
-- activated - see backend/README.md, "Runtime DB role"). Everything that runs the app's Prisma
-- client at request time should connect as this role instead of the migration superuser, so a bug
-- or an injected raw query cannot CREATE/DROP/ALTER, touch other schemas, or bypass row-level
-- security.
--
-- Created NOLOGIN so it cannot be used at all until an operator explicitly activates it with
-- `ALTER ROLE backend_runtime LOGIN PASSWORD '<generated>'` - `bun run secrets:generate` does NOT
-- manage this password. Idempotent-safe: every statement here can run again against a database
-- where the role, grants, or default privileges already exist (CREATE ROLE is guarded explicitly;
-- GRANT and ALTER DEFAULT PRIVILEGES are naturally idempotent in Postgres).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'backend_runtime') THEN
    CREATE ROLE backend_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END
$$;

-- `public`: full CRUD on every current and future table this backend owns, but no DDL (no CREATE,
-- no ALTER, no DROP) - schema changes stay the migration role's job (`MIGRATE_DATABASE_URL`).
GRANT USAGE ON SCHEMA public TO backend_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO backend_runtime;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO backend_runtime;

-- Applies to objects created from here on by whichever role runs future migrations (that role is
-- always the one executing this very statement, i.e. the migration/superuser role; deliberately
-- not hardcoded to one literal name so this migration behaves the same regardless of which one
-- runs it - see the note below on which role that needs to be for the `auth`-schema statements
-- further down). A model added later via `prisma migrate` therefore does not silently lock the
-- running backend out of its own table.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO backend_runtime;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO backend_runtime;

-- `auth`: read-only, and only the columns the admin directory's join actually selects
-- (`src/modules/users/infrastructure/admin-users-repository.ts` - `id` for the join predicate,
-- `email` for display). Never INSERT/UPDATE/DELETE: GoTrue owns this table, the backend never
-- writes to it (see backend/README.md), and this grant makes that invariant enforceable by
-- Postgres, not just by code review.
--
-- These `auth`-schema statements (both GRANTs here and the CREATE POLICY below) need a role with
-- real privilege on `auth` to run at all - in this self-hosted Supabase Postgres image, `postgres`
-- is NOT a superuser and only holds plain USAGE (no GRANT OPTION) on `auth`, owned by
-- `supabase_admin`. Running this migration as `postgres` makes Postgres silently WARN "no
-- privileges were granted for auth" and skip the GRANT USAGE line instead of erroring (CREATE
-- POLICY, unlike GRANT, does fail loudly for `postgres` the same way - "must be owner of table
-- users"). Run migrations as `supabase_admin` (same POSTGRES_PASSWORD - see
-- infra/supabase/README.md, "Rotating secrets") via `MIGRATE_DATABASE_URL` - the same role
-- backend/scripts/test-integration.mjs and webapp/e2e/plan.ts already use for this exact reason.
GRANT USAGE ON SCHEMA auth TO backend_runtime;
GRANT SELECT (id, email) ON auth.users TO backend_runtime;

-- `auth.users` ships with row-level security enabled (Supabase's default for every GoTrue-owned
-- table) and NO policies at all. With RLS on and zero policies, Postgres shows zero rows to any
-- role that is not the table owner or BYPASSRLS - `backend_runtime` is neither (NOBYPASSRLS above,
-- deliberately: this role must not skip RLS on tables that do carry real policies). Without this
-- policy the column-level GRANT above is inert: the admin directory's join always returns zero
-- rows for `backend_runtime`, silently, with no permission error to point at the cause.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy WHERE polrelid = 'auth.users'::regclass AND polname = 'backend_runtime_select'
  ) THEN
    CREATE POLICY backend_runtime_select ON auth.users FOR SELECT TO backend_runtime USING (true);
  END IF;
END
$$;
