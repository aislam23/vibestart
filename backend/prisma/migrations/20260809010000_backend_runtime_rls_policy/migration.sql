-- `auth.users` ships with row-level security enabled (Supabase's default for every GoTrue-owned
-- table) and NO policies at all. With RLS on and zero policies, Postgres shows zero rows to any
-- role that is not the table owner or BYPASSRLS - `backend_runtime` is neither (NOBYPASSRLS in the
-- `20260809000000_backend_runtime_role` migration, deliberately: this role must not skip RLS on
-- tables that do carry real policies). Without this policy the column-level GRANT SELECT (id,
-- email) ON auth.users from that earlier migration is inert: the admin directory's join always
-- returns zero rows for `backend_runtime`, silently, with no permission error to point at the
-- cause.
--
-- Idempotent-safe via the `pg_policies` check below, so this migration converges the same way
-- whether it is applied fresh or the policy was already created out of band.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'auth' AND tablename = 'users' AND policyname = 'backend_runtime_select'
  ) THEN
    CREATE POLICY backend_runtime_select ON auth.users FOR SELECT TO backend_runtime USING (true);
  END IF;
END
$$;
