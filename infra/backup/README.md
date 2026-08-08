# infra/backup

Scheduled, encrypted, **verified** Postgres backups to any S3-compatible
storage, with retention rotation, a tested restore path, and a heartbeat
so a silent backup failure looks like an incident, not silence.

**The golden rule: a backup you haven't restore-tested doesn't exist.**
Run the restore drill in this README against a throwaway target at least
quarterly - `restic backup` succeeding proves nothing about whether
`pg_restore` will actually work against that snapshot months from now.

## How it works

One small image (`Dockerfile`, `alpine:3.22` + `postgresql17-client` +
`restic` + `curl`) runs two scripts:

- **`backup.sh`**:
  1. Enumerates every non-template database on the cluster
     (`SELECT datname FROM pg_database WHERE NOT datistemplate`) and
     `pg_dump -Fc`s each one separately (`postgres.dump`, `_supabase.dump`,
     ...), plus `pg_dumpall --globals-only` (role definitions).
  2. `restic backup`s that staging directory **together with** a
     read-only mount of supabase's `db-config` volume, which holds the
     pgsodium root key (see "What this does NOT cover" below for why
     that key matters).
  3. Verifies the resulting snapshot - both a manifest check (every
     expected file actually reached the repository) and, weekly by
     default, a full `restic check` - and only *then* tags it `verified`.
  4. Applies the retention policy (`restic forget --prune`) - only after
     verification, never before.
  5. Pings a heartbeat URL on success, or `$HEARTBEAT_URL/fail` on any
     failure.
- **`restore.sh`** - downloads a snapshot (`latest` only ever resolves to
  one tagged `verified`), verifies every dump structurally
  (`pg_restore --list`), and - only with an explicit `--yes` *and*
  `RESTORE_ACK=yes` in the environment - restores each `<datname>.dump`
  into its like-named database with `pg_restore --clean --if-exists`.
  Without `--yes` it stops after download + verify (a safe dry run).

restic provides the encryption, deduplication, retention, and integrity
checking; `pg_dump -Fc` (custom format) is what makes each dump
restorable selectively/in parallel and independent of the client
Postgres version's exact minor build.

**Why crond runs as root**: busybox `crond` needs to run as root to work
reliably as a long-lived scheduler in a single-purpose container. The
scheduled job line drops to the unprivileged `backup` user via `su-exec`
before `backup.sh` runs, and one-shot `docker compose run` invocations go
through the same drop in `entrypoint.sh` - but that drop is a **file/uid**
boundary, not a secrets boundary: busybox `crond` inherits the full
container environment (verified directly - it does not clear or filter
env vars for jobs it spawns), so the scheduled job sees
`PGPASSWORD`/`RESTIC_PASSWORD` either way. The real reason this is safe
is that nothing *other than* `backup.sh`/`restore.sh` ever runs in this
container - the su-exec drop limits what a compromised job could touch on
disk (it can't write outside `backup`'s ownership), it does not hide
secrets from it.

## First-run setup

1. Create a dedicated S3 bucket and access key (see "S3 bucket
   recommendations" below).
2. `cp infra/backup/.env.example infra/backup/.env`, fill in `S3_ENDPOINT`,
   `S3_BUCKET`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, then
   `chmod 600 infra/backup/.env` (or `install -m 600 /dev/null infra/backup/.env`
   before filling it in) - it holds S3 and Postgres credentials.
3. Generate a restic password and set `RESTIC_PASSWORD`:
   ```bash
   openssl rand -base64 32
   ```
   **Store this password somewhere durable and separate from `.env`**
   (password manager, secrets vault) - **never inside this stack's own
   restic repository** (a password can't decrypt the backup it's stored
   in, and if `.env` is lost so is the only copy). Losing it means losing
   every backup - restic cannot decrypt a repository without it, and
   there is no recovery path.
4. Copy `POSTGRES_PASSWORD` from `infra/supabase/.env` into `PGPASSWORD`
   here by hand (deliberately not auto-read from the other stack's `.env`
   - see the comment in `.env.example`).
5. `make backup-up` (or `docker compose -f infra/backup/docker-compose.yml up -d`)
   starts the scheduled service. The first scheduled run auto-creates the
   restic repository (`restic init`) if it doesn't exist yet - no manual
   init step needed. Any *other* failure to reach the repository (wrong
   password, network/auth error) deliberately does **not** auto-init -
   see "Repository safety" below.
6. Run `make backup` once by hand to confirm the whole path works before
   trusting the schedule, then check `docker compose -f infra/backup/docker-compose.yml logs backup`.

## Repository safety

Two guards prevent the two ways an "auto-init on failure" backup script
quietly destroys history:

- **No init on an arbitrary failure.** `backup.sh` probes with
  `restic cat config` first. It only runs `restic init` when that probe
  returns restic's documented "repository does not exist" exit code
  (`10`). Any other failure - wrong password (`12`), repository locked
  (`11`), a network timeout, an auth error - aborts immediately without
  touching the repository. The old `restic snapshots || restic init`
  pattern could not tell "repo is empty" apart from "repo is
  unreachable" and would happily `init` (silently starting a second,
  empty repository) on the latter.
- **Split-brain guard.** After the first successful init, `backup.sh`
  records the repository's id (from `restic cat config`) at
  `/var/cache/restic/repo-id` (the `restic-cache` named volume, so it
  survives container recreation). Every later run compares the live
  repo's id against that file and **aborts** on a mismatch - this is
  what catches `S3_BUCKET`/`S3_PATH` silently pointing at a different
  (possibly fresh, auto-initable) prefix, which would otherwise look
  like a normal successful backup while quietly starting a second,
  disconnected backup history. If you deliberately migrate to a new
  repository, remove `/var/cache/restic/repo-id` (i.e. `docker volume rm`
  the `restic-cache` volume, or exec in and delete the file) to accept it.

## Verified-snapshot workflow

Every backup goes through, in order: `restic backup --json` (capturing
the snapshot id from its summary line) → the weekly (by default) full
`restic check` → a manifest check (`restic ls` against the snapshot
itself, confirming every expected `<datname>.dump` + `globals.sql` + the
`db-config` directory are actually present in the repository - not just
that `pg_dump` exited zero locally) → `restic tag --add verified`.

Two failure modes are treated as **quarantine, not retry**: `restic
backup` exiting `3` (some source file could not be read - an incomplete
snapshot was still created) and a failed manifest/check step. Both run
`restic forget <snapshot-id>` on the bad snapshot before failing loudly,
so a broken backup never lingers where `restore.sh`'s `latest` might
reach it and never silently counts toward retention.

`restic tag` creates a **new** snapshot object in place of the old one
(tags are part of a snapshot's content-addressed data, so tagging changes
its id) and removes the pre-tag object as part of the same operation -
confirmed directly against a live repository: nothing double-counts
against retention, and there's no separate cleanup step needed after a
successful tag.

`restore.sh restore latest` only ever resolves to a snapshot carrying the
`verified` tag - if none exists yet, it fails with a clear message rather
than silently restoring an unchecked one. Passing an explicit snapshot id
(from `restore.sh list`) still works against an unverified snapshot, with
a printed warning.

## Restore procedure

**Stop the backend and any other Postgres writer first.** A live writer
during `pg_restore` will corrupt the result - this isn't optional.

```bash
# 1. See what's available (Tags column shows which snapshots are `verified`)
make restore
# (equivalent: docker compose -f infra/backup/docker-compose.yml run --rm backup /usr/local/bin/restore.sh list)

# 2. Dry run - downloads + structurally verifies every dump, touches nothing
docker compose -f infra/backup/docker-compose.yml run --rm backup \
  /usr/local/bin/restore.sh restore latest

# 3. Take a host-side safety net (independent of the restic repository -
#    a raw tar of the live db-data + db-config volumes, so you can roll
#    back even if the restore itself goes wrong)
make pre-restore-snapshot

# 4. The real thing, once you've confirmed the dry run looks right.
#    --yes alone is not enough - restore.sh also requires RESTORE_ACK=yes,
#    a deliberate second confirmation that you've actually done steps 1 and 3.
docker compose -f infra/backup/docker-compose.yml run --rm -e RESTORE_ACK=yes backup \
  /usr/local/bin/restore.sh restore latest --yes
```

Pass a specific snapshot ID instead of `latest` (from `restore.sh list`)
to restore an older point in time. `--with-globals` additionally applies
the captured `pg_dumpall --globals-only` output - only meaningful when
restoring into a *fresh* Postgres cluster; against an existing supabase
stack the roles already exist, and `psql` reports (but doesn't abort on)
those per-role errors - see "Globals" below.

`make restore` (no other args) only ever runs `restore.sh list` - the
Makefile target is intentionally not wired to actually restore anything;
that always requires the explicit `restore.sh restore ... --yes` command
above, run by a human who has just read this section, gated by both
`--yes` and `RESTORE_ACK=yes`.

**Numbered procedure:**

1. Stop dependent services (`backend`, and anything else that writes to
   this database - the scheduler sibling process, if enabled, and any
   worker) - `docker compose -f infra/app/docker-compose.yml stop backend`
   (add `scheduler`/`worker` if those are running). Do **not** stop
   `infra/edge` - it serves `webapp`/`website` static assets independently
   of `db`, and stopping it only adds unrelated downtime; it will simply
   proxy 502s for `API_DOMAIN` while `backend` is down. Postgres (`db`)
   itself stays up - `restore.sh` needs a live connection to it.
2. `make pre-restore-snapshot` - see "Pre-restore safety net" below.
3. Run the restore (steps 1-4 above).
4. **Verify application data**, not the pg_restore error log - see below.
5. Restart the dependent services stopped in step 1.
6. Rollback, if verification fails: stop `db`, untar the pre-restore
   snapshot over the live volumes (the exact command is printed by `make
   pre-restore-snapshot`), restart `db`.

**Expect `pg_restore` to report a wall of errors and exit non-zero when
restoring in-place into a live self-hosted Supabase database - this can
be normal, not automatically a broken restore.** The `postgres` role in
this stack is not a true superuser (`supabase_admin` is), so `pg_restore`
can't re-create Supabase-internal objects (schemas, extensions, event
triggers, `auth.*` tables) that already exist in the target; those errors
are typically harmless no-ops. `restore.sh` prints an explanation and
re-raises the exit code rather than hiding it, per database.

**There is exactly one acceptance criterion for a restore: your own
application-data verification queries return what you expect. Nothing
else - not the pg_restore error count, not "it looked fine" - counts.**
Concretely, after every restore, at minimum:

```sql
-- row counts on your own tables look right for the point in time restored
SELECT count(*) FROM public.<your_table>;
-- the most recent rows you expect are actually present
SELECT max(created_at) FROM public.<your_table>;
-- spot-check a specific known row survived intact
SELECT * FROM public.<your_table> WHERE id = '<a row you know existed>';
```

If any of those look wrong, or you're in doubt for any other reason: roll
back (step 6 above) rather than trying to reconcile a half-restored
database by hand.

### Restoring the pgsodium key (`db-config`)

The read-only mount in this stack is enough to *back up* `db-config`, but
not to restore it (the backup container never has write access to that
volume). If the `db-config` **Docker volume itself** was lost (disk
failure, `docker volume rm` by mistake) - not just the database - restore
it manually from a snapshot's `db-config` directory:

```bash
docker compose -f infra/supabase/docker-compose.yml stop db
docker compose -f infra/backup/docker-compose.yml run --rm backup \
  /usr/local/bin/restore.sh restore latest   # dry run - downloads db-config into /work too
docker run --rm -v supabase_db-config:/dest -v vibestart_backup-work:/src:ro \
  alpine:3.22 sh -c 'cp -a /src/restore.*/db-config/. /dest/'
docker compose -f infra/supabase/docker-compose.yml start db
```
(Find the exact `restore.*` staging directory name and the `backup-work`
volume's actual project-prefixed name with `docker volume ls` - the
prefix depends on which compose project name was used to bring the
backup stack up.) This only matters if `db-config` itself is gone; a
normal in-place restore of `postgres`/`_supabase` doesn't touch it.

## Retention model

`restic forget --prune` runs after every verified backup with:

| Env var | Default | Meaning |
|---|---|---|
| `KEEP_DAILY` | 7 | Most recent 7 daily snapshots |
| `KEEP_WEEKLY` | 4 | Most recent 4 weekly snapshots |
| `KEEP_MONTHLY` | 6 | Most recent 6 monthly snapshots |

Two things had to be fixed for this to actually work: `backup.sh` now
stages its dumps at a **fixed path** (`/work/staging`, purged at the
start of every run) instead of a fresh `mktemp` directory each time -
restic's default retention grouping is by `(host, paths)`, so a
different path every run meant every snapshot landed in its own group of
one and `forget` never had more than one snapshot to compare against a
group, so nothing was ever expired. `forget` also now passes
`--group-by host,tags` explicitly as a second, independent fix - belt
and suspenders against the same failure mode recurring.

restic's dedup means overlapping retention buckets cost far less than
`KEEP_DAILY + KEEP_WEEKLY + KEEP_MONTHLY` full copies - only the changed
data between snapshots takes new space. `RESTIC_CHECK` (default `weekly`,
Sundays only) runs a full data-integrity pass; set to `always` if your
repo is small enough that a nightly check is cheap, or `never` to disable
(not recommended - an undetected corrupt snapshot is worse than a missing
one, because it looks fine until you need it). This is independent of
the manifest check described above, which runs on every backup regardless
of `RESTIC_CHECK`.

## Globals

`pg_dumpall --globals-only --no-role-passwords` captures role/grant
definitions that live outside any single database. `--no-role-passwords`:
role passwords in this stack are (re)applied by supabase's own init
scripts from `.env` on a fresh cluster (`infra/supabase/volumes/db/roles.sql`),
not by replaying this dump, so capturing password hashes here would be
dead weight (and one more secret sitting in the backup). `backup.sh`
prefers running this as `supabase_admin` (the actual Postgres superuser
in this image, vs. `postgres` which is not) using the same `PGPASSWORD` -
confirmed working against a live stack, `supabase_admin` authenticates
with the same password as `postgres` in this image. It falls back to
`$PGUSER` if that ever fails (e.g. a future image changes this) - check
the backup log for which one ran.

`restore.sh --with-globals` applies the captured `globals.sql` via
`psql -X` with no error suppression: a real connection or parse failure
now aborts the script (previously hidden behind an unconditional
`|| true`). Per-role "already exists" errors on an existing cluster are
still expected and harmless - `psql` without `-v ON_ERROR_STOP=1`
continues past individual statement errors and only exits non-zero on a
connection-level failure or when the *last* statement in the file fails,
so this only matters on a fresh cluster.

## Bounded execution, and no overlap

Every `pg_dump`/`pg_dumpall`/`psql`/`pg_restore` call is wrapped in
`timeout -k 30 $PG_TIMEOUT` (default 3600s), and every `restic` call in
`timeout -k 30 $RESTIC_TIMEOUT` (default 1800s) - `-k 30` sends `SIGKILL`
30s after the initial signal for anything that ignores it.
`PGCONNECT_TIMEOUT=10` is exported so a hung TCP handshake to `db` can't
stall a run before either timeout even starts counting.

`backup.sh` and `restore.sh` share an exclusive `flock` on
`/work/backup.lock` (the `backup-work` volume) - a scheduled backup, a
manual `make backup`, and any restore can never run concurrently against
the same repository. A second run started while one is in progress fails
immediately with a clear "already running" message rather than
interleaving pg_dump/restic calls against the same staging directory.

## Trap hardening

The `EXIT`/`INT`/`TERM` trap is installed as the very first executable
line in both scripts, before required-env-var checks or any I/O - so
even a missing `PGPASSWORD` still goes through the same failure-heartbeat
path as a mid-run crash. `INT`/`TERM` exit `130`/`143` respectively (the
conventional 128+signal codes) after running the same cleanup. Cleanup
itself is non-fatal (`rm -rf ... || true`, lock release swallowed) so a
failed cleanup step never masks the *real* failure that triggered it -
except the heartbeat ping, which is never blindly swallowed: both the
success and failure pings check `curl`'s exit code and log whether the
ping itself actually got through, so "backup succeeded but nobody found
out" and "backup failed and the fail-ping also failed" are both visible
in the logs instead of silently absorbed.

**`SIGKILL` (OOM killer, `docker kill -s KILL`) cannot be trapped at
all** - no cleanup or failure ping runs. The only thing that catches that
case is the heartbeat's own dead-man expiry: configure the monitor's
expected period with enough slack over `BACKUP_CRON` that a killed run
is detected by *absence* of a ping, not by a fail-ping that will never
arrive. The fixed staging path being purged at the start of every run
also means a `SIGKILL` leftover from a previous run never confuses the
next one.

## Heartbeat setup

`backup.sh` treats `HEARTBEAT_URL` as a dead man's switch: it pings that
URL on full success, and `"$HEARTBEAT_URL/fail"` on any failure (trapped
on `EXIT`/`INT`/`TERM`, so a crash mid-script still fires the fail ping -
see "Trap hardening" above for the one case it can't catch). Point it at:

- **[healthchecks.io](https://healthchecks.io)** - create a check with the
  expected period matching `BACKUP_CRON` (with slack for the `SIGKILL`
  case above), use its ping URL as `HEARTBEAT_URL`. It already
  understands the `/fail` suffix convention used here.
- **Uptime Kuma** - a "Push" monitor type gives a compatible ping URL.

Leave `HEARTBEAT_URL` empty to disable - the container now prints a loud
startup warning ("backups are UNMONITORED") when you do, both in
scheduled and one-shot mode, so this is a visible decision rather than a
silent gap. Set it up before relying on this in production.

## S3 bucket recommendations

- **Dedicated bucket** - don't share it with Supabase Storage's app
  bucket or anything else; makes lifecycle rules, cost tracking, and
  blast radius all simpler.
- **Restricted access key** - scope the key to only this bucket
  (read/write/list/delete), not full account access.
- **Versioning: recommended, not optional.** restic already keeps full
  snapshot history and content-addresses everything, so bucket-level
  versioning is redundant for *normal* operation - but it's real defense
  in depth against a compromised host or leaked `RESTIC_PASSWORD`
  combined with a malicious `restic forget --prune`, which bucket
  versioning (or object lock) can still recover from even after restic's
  own history says the data is gone.

## Hardening

- **Append-only / immutable bucket policies, or a second offline copy.**
  If the host running this container is ever compromised, an attacker
  with the AWS credentials in `.env` can run `restic forget --prune`
  themselves and erase backup history through the front door - restic's
  own encryption doesn't protect against that, only the storage layer
  can. Provider-specific (S3 Object Lock in compliance mode, B2's
  application-key restrictions, a second bucket/provider the primary
  credentials can't reach), pattern only - pick what your provider
  supports.
- **`.dockerignore`** in this directory keeps `.env`/`*.backup.*` out of
  the build context entirely, so they can never end up baked into an
  image layer even by accident.
- **`chmod 600 infra/backup/.env`** after filling it in (see "First-run
  setup") - it's the only place `PGPASSWORD`/`RESTIC_PASSWORD`/AWS keys
  live outside the container's own environment.

## What this does NOT cover

- **`infra/**/.env` files** (this stack's own `.env` included) are never
  backed up, on purpose - **never put the restic password (or anything
  else that decrypts these backups) inside the backups themselves.**
  Keep copies of every `infra/**/.env` in a password manager or secrets
  vault, separate from both the repo and the restic repository.
- **Supabase Storage files, when `STORAGE_BACKEND=file`** (the default,
  intended for local dev): they live in the `storage-data` Docker volume
  and are **not** covered by this stack at all - no volume mount, no
  restic backup. Production should run `STORAGE_BACKEND=s3` (see
  `infra/supabase/README.md`, "Storage: local disk vs S3") pointed at a
  bucket with the storage provider's own versioning/replication turned
  on. Either way, a `storage.objects` database row surviving a restore
  with no matching file in the bucket (or vice versa) is a real failure
  mode if the two aren't recovered together to matching points in time.

## Testing

Not automated in CI (`.github/workflows/ci.yml`, added in T7, covers
typecheck/lint/unit/integration/e2e/build for `backend`/`webapp`/`website`
only - it does not exercise this stack). The manual restore drill above
remains the only tested path; a CI job that runs the full MinIO
backup→restore cycle automatically on every push is a reasonable future
addition, not implemented here.
