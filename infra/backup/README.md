# infra/backup

Scheduled, encrypted Postgres backups to any S3-compatible storage, with
retention rotation, a tested restore path, and a heartbeat so a silent
backup failure looks like an incident, not silence.

**The golden rule: a backup you haven't restore-tested doesn't exist.**
Run the restore drill in this README against a throwaway target at least
quarterly - `restic backup` succeeding proves nothing about whether
`pg_restore` will actually work against that snapshot months from now.

## How it works

One small image (`Dockerfile`, `alpine:3.22` + `postgresql17-client` +
`restic` + `curl`) runs two scripts:

- **`backup.sh`** - `pg_dump -Fc` of the `postgres` database plus
  `pg_dumpall --globals-only` (role definitions), both fed into a single
  `restic backup`. Then `restic forget --prune` applies the retention
  policy, and (on Sundays by default) `restic check` verifies repository
  integrity. Pings a heartbeat URL on success, or `$HEARTBEAT_URL/fail` on
  any failure.
- **`restore.sh`** - downloads a snapshot, verifies it structurally
  (`pg_restore --list`), and - only with an explicit `--yes` - applies it
  with `pg_restore --clean --if-exists`. Without `--yes` it stops after
  download + verify (a safe dry run).

restic provides the encryption, deduplication, retention, and integrity
checking; `pg_dump -Fc` (custom format) is what makes the dump restorable
selectively/in parallel and independent of the client Postgres version's
exact minor build.

**Why crond runs as root**: busybox `crond` needs to run as root to work
reliably as a long-lived scheduler in a single-purpose container. It never
touches secrets or the network itself - the scheduled job line drops to
the unprivileged `backup` user via `su-exec` before `backup.sh` runs, and
one-shot `docker compose run` invocations go through the same drop in
`entrypoint.sh`. Root's only other privilege in this container is writing
the generated crontab file at container start.

## First-run setup

1. Create a dedicated S3 bucket and access key (see "S3 bucket
   recommendations" below).
2. `cp infra/backup/.env.example infra/backup/.env`, fill in `S3_ENDPOINT`,
   `S3_BUCKET`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`.
3. Generate a restic password and set `RESTIC_PASSWORD`:
   ```bash
   openssl rand -base64 32
   ```
   **Store this password somewhere durable and separate from `.env`**
   (password manager, secrets vault). Losing it means losing every
   backup - restic cannot decrypt a repository without it, and there is no
   recovery path.
4. Copy `POSTGRES_PASSWORD` from `infra/supabase/.env` into `PGPASSWORD`
   here by hand (deliberately not auto-read from the other stack's `.env`
   - see the comment in `.env.example`).
5. `make backup-up` (or `docker compose -f infra/backup/docker-compose.yml up -d`)
   starts the scheduled service. The first scheduled run auto-creates the
   restic repository (`restic init`) if it doesn't exist yet - no manual
   init step needed.
6. Run `make backup` once by hand to confirm the whole path works before
   trusting the schedule, then check `docker compose -f infra/backup/docker-compose.yml logs backup`.

## Restore procedure

**Stop the backend and any other Postgres writer first.** A live writer
during `pg_restore` will corrupt the result - this isn't optional.

```bash
# 1. See what's available
make restore
# (equivalent: docker compose -f infra/backup/docker-compose.yml run --rm backup /usr/local/bin/restore.sh list)

# 2. Dry run - downloads + structurally verifies the snapshot, touches nothing
docker compose -f infra/backup/docker-compose.yml run --rm backup \
  /usr/local/bin/restore.sh restore latest

# 3. The real thing, once you've confirmed the dry run looks right
docker compose -f infra/backup/docker-compose.yml run --rm backup \
  /usr/local/bin/restore.sh restore latest --yes
```

Pass a specific snapshot ID instead of `latest` (from `restore.sh list`)
to restore an older point in time. `--with-globals` additionally applies
the captured `pg_dumpall --globals-only` output - only meaningful when
restoring into a *fresh* Postgres cluster; against an existing supabase
stack the roles already exist and this is a harmless no-op.

`make restore` (no other args) only ever runs `restore.sh list` - the
Makefile target is intentionally not wired to actually restore anything;
that always requires the explicit `restore.sh restore ... --yes` command
above, run by a human who has just read this section.

**Expect `pg_restore` to report a wall of errors and exit non-zero when
restoring in-place into a live self-hosted Supabase database - this is
normal, not a broken restore.** The `postgres` role in this stack is not
a true superuser (`supabase_admin` is), so `pg_restore` can't re-create
Supabase-internal objects (schemas, extensions, event triggers, `auth.*`
tables) that already exist in the target; those errors are harmless
no-ops. `restore.sh` prints an explanation and re-raises the exit code
rather than hiding it - read the error list for anything touching *your
own* application schema/tables, not the Supabase-internal ones, as the
real signal. Confirmed against a live test restore: 192 such errors,
zero data loss, application table and rows restored correctly.

## Retention model

`restic forget --prune` runs after every backup with:

| Env var | Default | Meaning |
|---|---|---|
| `KEEP_DAILY` | 7 | Most recent 7 daily snapshots |
| `KEEP_WEEKLY` | 4 | Most recent 4 weekly snapshots |
| `KEEP_MONTHLY` | 6 | Most recent 6 monthly snapshots |

restic's dedup means overlapping retention buckets cost far less than
`KEEP_DAILY + KEEP_WEEKLY + KEEP_MONTHLY` full copies - only the changed
data between snapshots takes new space. `RESTIC_CHECK` (default `weekly`,
Sundays only) runs a full data-integrity pass; set to `always` if your
repo is small enough that a nightly check is cheap, or `never` to disable
(not recommended - an undetected corrupt snapshot is worse than a missing
one, because it looks fine until you need it).

## Heartbeat setup

`backup.sh` treats `HEARTBEAT_URL` as a dead man's switch: it pings that
URL on full success, and `"$HEARTBEAT_URL/fail"` on any failure (trapped
on `EXIT`/`INT`/`TERM`, so a crash mid-script still fires the fail ping).
Point it at:

- **[healthchecks.io](https://healthchecks.io)** - create a check with the
  expected period matching `BACKUP_CRON`, use its ping URL as
  `HEARTBEAT_URL`. It already understands the `/fail` suffix convention
  used here.
- **Uptime Kuma** - a "Push" monitor type gives a compatible ping URL.

Leave `HEARTBEAT_URL` empty to disable - but then a silent backup failure
is genuinely silent, which is the exact failure mode this whole stack
exists to avoid. Set it up before relying on this in production.

## S3 bucket recommendations

- **Dedicated bucket** - don't share it with Supabase Storage's app
  bucket or anything else; makes lifecycle rules, cost tracking, and
  blast radius all simpler.
- **Restricted access key** - scope the key to only this bucket
  (read/write/list/delete), not full account access.
- **Versioning: optional.** restic already keeps full snapshot history
  and content-addresses everything, so bucket-level versioning is
  redundant for this data. It's more useful as a second line of defense
  against a compromised/leaked restic password combined with malicious
  `forget --prune` calls - decide based on your threat model.

## What this does NOT cover

**Supabase Storage files live in the app's own S3 bucket
(`GLOBAL_S3_BUCKET` in `infra/supabase/.env`, see that stack's README
"Storage: local disk vs S3") and are NOT covered by this database
backup.** This stack only backs up Postgres. Protect the Storage bucket
separately with your provider's own versioning/replication - a
`storage.objects` row surviving a database restore with no matching file
in the bucket (or vice versa) is a real failure mode if the two aren't
backed up together with matching recovery points.
