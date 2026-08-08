-- Test-only fixture for db_test (backend/docker-compose.test.yml).
--
-- In every real environment, `auth.users` is created and owned by Supabase Auth (GoTrue) via its
-- own migrations when the `auth` service boots (see infra/supabase/docker-compose.yml) - Postgres
-- itself never creates it. db_test never runs GoTrue: starting it just for a table shape would
-- make integration tests slow and would still not be "real" GoTrue data. Instead this stub creates
-- just enough of `auth.users` (id, email) for the admin directory's read-only join
-- (backend/src/modules/users/infrastructure/admin-users-repository.ts) to work against real
-- Postgres, and integration tests insert directly into it to set up fixtures.
--
-- Never mirror more of GoTrue's real schema here than a test actually needs, and never write to
-- this table from application code - the repository comment explains why.
CREATE SCHEMA IF NOT EXISTS auth;

CREATE TABLE auth.users (
  id uuid PRIMARY KEY,
  email text NOT NULL
);
