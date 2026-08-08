# Backups

Summary and pointer. **`infra/backup/README.md` is the source of truth** — every command, every
safety mechanism, and the full restore procedure live there. This document exists so other docs
have somewhere short to link to; read the full README before touching anything backup-related in
production.

## What it is

`infra/backup` runs a scheduled, encrypted, **verified** Postgres backup of the self-hosted
Supabase database to any S3-compatible storage: `pg_dump -Fc` every non-template database plus role
definitions, `restic backup` the result (together with a read-only copy of Supabase's `db-config`
volume, which holds the pgsodium encryption root key), verify the snapshot (manifest check every
backup, a full `restic check` weekly by default), tag it `verified`, then apply retention
(`restic forget --prune`) — strictly in that order, so nothing gets pruned before it's confirmed
good.

A heartbeat URL (`healthchecks.io`, Uptime Kuma, or similar) turns a silent failure into a visible
incident: `backup.sh` pings it on success and pings a `/fail` variant on any failure, trapped so
even a crash mid-script still fires it.

## The golden rule

**A backup you haven't restore-tested doesn't exist.** `restic backup` succeeding proves nothing
about whether `pg_restore` will actually work against that snapshot months from now. Run the
restore drill in `infra/backup/README.md` against a throwaway target **at least quarterly**.

## Restore, in outline

1. `make restore` — lists available snapshots (the `Tags` column shows which are `verified`).
2. Dry run — `restore.sh restore latest` downloads and structurally verifies every dump, touches
   nothing.
3. `make pre-restore-snapshot` — a host-side, restic-independent safety net (raw tar of the live
   Postgres volumes) before doing anything destructive.
4. The real restore requires **both** `--yes` and `RESTORE_ACK=yes` — two independent
   confirmations that you've actually read the runbook and taken the pre-restore snapshot.
5. Verify with your own application-data queries (row counts, most-recent timestamps, a known row)
   — not the `pg_restore` exit code or log noise. Restoring in-place into a live self-hosted
   Supabase database is expected to print a wall of harmless errors (the `postgres` role isn't a
   true superuser here, so it can't re-create Supabase-internal objects that already exist).
6. Roll back via the pre-restore snapshot if verification fails.

`make restore` deliberately only ever lists snapshots — the actual restore command is never a
one-line Makefile target, on purpose.

## What's covered, and what isn't

**Covered:** every database in the Postgres cluster, role/grant definitions (globals), and the
pgsodium root key (`db-config`).

**Not covered:**

- `infra/**/.env` files (including this stack's own) — never back up the credentials that decrypt
  the backups. Keep copies in a password manager, separate from both the repo and the restic
  repository.
- Supabase Storage files when `STORAGE_BACKEND=file` (the local-dev default) — they live in a
  Docker volume with no restic mount at all. Production should run `STORAGE_BACKEND=s3` (see
  `docs/SUPABASE.md`) pointed at a bucket with the storage provider's own versioning/replication —
  and recover the storage bucket and the database restore together, to matching points in time, or
  a `storage.objects` row can point at a file that no longer exists (or vice versa).

## Retention

Default `KEEP_DAILY=7` / `KEEP_WEEKLY=4` / `KEEP_MONTHLY=6`, restic-deduplicated so overlapping
buckets cost far less than the naive sum. `RESTIC_CHECK` (default `weekly`) runs a full
data-integrity pass independent of the per-backup manifest check.

## Hardening reminders

- Append-only/immutable bucket policies (or a second offline copy) — restic's own encryption
  doesn't protect backup history from an attacker holding the same AWS credentials `.env` does.
- A dedicated S3 bucket, not shared with Supabase Storage's app bucket.
- `chmod 600 infra/backup/.env` — it's the only place `PGPASSWORD`/`RESTIC_PASSWORD`/AWS keys live
  outside the container's own environment.
- The restic password lives **only** in a password manager or secrets vault — never inside the
  repository it decrypts, and never only in `.env`. Losing it means losing every backup; there is
  no recovery path.

## See also

- `infra/backup/README.md` — the full mechanism: repository-safety guards (no accidental
  auto-init, the split-brain check), bounded execution and locking, trap hardening, the exact
  restore procedure, heartbeat setup, S3 bucket recommendations.
- `docs/DEPLOYMENT.md` — where backup setup fits in the first-deploy sequence.
- `docs/SUPABASE.md` — the storage backend this backup stack does and doesn't cover.
