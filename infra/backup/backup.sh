#!/bin/sh
# One full backup cycle:
#   pg_dump -Fc (every non-template database) + pg_dumpall --globals-only +
#   the supabase db-config volume (pgsodium root key, mounted read-only)
#   -> restic backup --json -> manifest-presence check (+ weekly restic
#   check) -> tag verified -> retention (forget --prune) -> heartbeat.
#
# Runs as the unprivileged `backup` user (entrypoint.sh drops via su-exec).
# `set -e` means ANY failed step aborts here; the EXIT trap below only
# pings the success heartbeat when $STATUS was explicitly set to 0 at the
# very end, so every failure path (including a crash mid-script or a
# SIGKILL caught by the OOM killer) falls through to the failure ping
# instead - see README "Heartbeat". SIGKILL itself can't be trapped at
# all - that's what the heartbeat's dead-man expiry is for.
set -euo pipefail

: "${PGHOST:=db}"
: "${PGPORT:=54322}"
: "${PGUSER:=postgres}"
: "${PGDATABASE:=postgres}"   # connection used only to enumerate databases
: "${KEEP_DAILY:=7}"
: "${KEEP_WEEKLY:=4}"
: "${KEEP_MONTHLY:=6}"
: "${S3_PATH:=vibestart/postgres}"
: "${RESTIC_CHECK:=weekly}"   # weekly (Sundays only) | always | never
: "${RESTIC_TIMEOUT:=1800}"   # seconds; hard cap per restic invocation
: "${PG_TIMEOUT:=3600}"       # seconds; hard cap per pg_dump/pg_dumpall call
: "${STAGING_DIR:=/work/staging}"
: "${LOCK_FILE:=/work/backup.lock}"
: "${RESTIC_CACHE_DIR:=/var/cache/restic}"
: "${DB_CONFIG_DIR:=/db-config}"  # read-only mount of supabase's db-config volume

STATUS=1              # flipped to 0 only after every step below has succeeded
LOCK_HELD=0
SNAPSHOT_ID=""

# ---- trap: installed first, before required-var checks or any I/O, so ----
# ---- every failure path from here on (including a bad env var) is caught.
cleanup() {
    rc=$?
    # Only the lock holder may touch $STAGING_DIR: a process that lost
    # the flock race and is exiting immediately must NOT rm -rf the
    # staging directory out from under whichever process actually holds
    # the lock and is mid-dump into it (this was live-tested and caught -
    # an unconditional rm here deleted a concurrent winner's in-progress
    # staging data).
    if [ "$LOCK_HELD" -eq 1 ]; then
        rm -rf "$STAGING_DIR" 2>/dev/null || true
        flock -u 9 2>/dev/null || true
    fi
    if [ "$rc" -ne 0 ] || [ "$STATUS" -ne 0 ]; then
        echo "backup.sh: FAILED (exit $rc)" >&2
        if [ -n "${HEARTBEAT_URL:-}" ]; then
            if curl -fsS -m 10 --retry 3 "${HEARTBEAT_URL%/}/fail" >/dev/null 2>&1; then
                echo "backup.sh: failure heartbeat sent"
            else
                echo "backup.sh: failure heartbeat FAILED to send" >&2
            fi
        fi
    fi
}
on_int() { trap - EXIT INT TERM; cleanup; exit 130; }
on_term() { trap - EXIT INT TERM; cleanup; exit 143; }
trap cleanup EXIT
trap on_int INT
trap on_term TERM

: "${PGPASSWORD:?PGPASSWORD is required - copy POSTGRES_PASSWORD from infra/supabase/.env}"
: "${RESTIC_PASSWORD:?RESTIC_PASSWORD is required - see .env.example}"
: "${S3_ENDPOINT:?S3_ENDPOINT is required}"
: "${S3_BUCKET:?S3_BUCKET is required}"
: "${AWS_ACCESS_KEY_ID:?AWS_ACCESS_KEY_ID is required}"
: "${AWS_SECRET_ACCESS_KEY:?AWS_SECRET_ACCESS_KEY is required}"

export PGHOST PGPORT PGUSER PGDATABASE PGPASSWORD
export PGCONNECT_TIMEOUT=10
export RESTIC_PASSWORD AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY
export RESTIC_REPOSITORY="s3:${S3_ENDPOINT}/${S3_BUCKET}/${S3_PATH}"

# restic retries backend I/O errors (including auth failures against a
# misconfigured/rotated S3 key) with its own backoff and no built-in cap,
# so a bad credential can otherwise hang a run indefinitely - past its
# cron window and past the point where the failure heartbeat would ever
# fire. Every restic call below goes through this hard per-call timeout
# instead of a bare `restic`. -k 30 sends SIGKILL 30s after SIGTERM for
# calls that ignore the timeout's initial signal.
restic() { command timeout -k 30 "$RESTIC_TIMEOUT" restic "$@"; }
# Same reasoning for pg_dump/pg_dumpall: a stuck connection (network
# partition to `db`, a lock held forever) must not hang past the cron
# window either.
pgrun() { command timeout -k 30 "$PG_TIMEOUT" "$@"; }

# ---- exclusive lock: shared with restore.sh so a scheduled backup and a ----
# ---- manual restore (or two overlapping backups) can never run at once.
mkdir -p "$(dirname "$LOCK_FILE")"
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
    echo "backup.sh: another backup/restore is already running (lock held: $LOCK_FILE) - aborting" >&2
    exit 1
fi
LOCK_HELD=1

# ---- staging: fixed path (not mktemp) so the source path restic records ----
# ---- for every snapshot is identical run over run - retention buckets
# (see the --group-by fix below) depend on this. Purge first: covers a
# SIGKILL/OOM leftover from a previous run that never reached the trap.
rm -rf "$STAGING_DIR"
mkdir -p "$STAGING_DIR"

# ---- repository existence/identity guard: never auto-init on an ----
# ---- arbitrary failure, and never silently switch to a different repo.
probe_out="/work/.restic-cat-config.out"
probe_err="/work/.restic-cat-config.err"
set +e
restic cat config >"$probe_out" 2>"$probe_err"
probe_rc=$?
set -e

if [ "$probe_rc" -eq 10 ]; then
    echo "backup.sh: repository not found at $RESTIC_REPOSITORY - running restic init"
    restic init
    restic cat config >"$probe_out"
elif [ "$probe_rc" -ne 0 ]; then
    echo "backup.sh: restic cat config failed (exit $probe_rc) - aborting WITHOUT init" >&2
    echo "backup.sh: (exit 12 = wrong RESTIC_PASSWORD, 11 = repo locked, other = network/auth/timeout)" >&2
    cat "$probe_err" >&2
    exit "$probe_rc"
fi

current_repo_id=$(grep -o '"id": *"[^"]*"' "$probe_out" | head -n1 | sed -E 's/.*"([0-9a-f]+)"$/\1/')
rm -f "$probe_out" "$probe_err"
if [ -z "$current_repo_id" ]; then
    echo "backup.sh: could not parse repository id from 'restic cat config' output" >&2
    exit 1
fi

repo_id_file="$RESTIC_CACHE_DIR/repo-id"
if [ -f "$repo_id_file" ]; then
    stored_repo_id="$(cat "$repo_id_file")"
    if [ "$stored_repo_id" != "$current_repo_id" ]; then
        echo "backup.sh: REPOSITORY ID MISMATCH - expected $stored_repo_id (from $repo_id_file), got $current_repo_id" >&2
        echo "backup.sh: this means RESTIC_REPOSITORY (S3_ENDPOINT/S3_BUCKET/S3_PATH) now points at a DIFFERENT repository" >&2
        echo "backup.sh: than the one this host has been backing up to - possibly a fresh/empty prefix that just got" >&2
        echo "backup.sh: auto-initialized. Aborting to avoid silently splitting backup history. If this change is" >&2
        echo "backup.sh: intentional, remove $repo_id_file to accept the new repository." >&2
        exit 1
    fi
else
    mkdir -p "$RESTIC_CACHE_DIR"
    echo "$current_repo_id" >"$repo_id_file"
    echo "backup.sh: recorded repository id $current_repo_id at $repo_id_file"
fi

# ---- dump every non-template database, plus globals -----------------------
echo "backup.sh: enumerating non-template databases on ${PGHOST}:${PGPORT}"
databases=$(pgrun psql -Atqc "SELECT datname FROM pg_database WHERE NOT datistemplate ORDER BY datname" -d "$PGDATABASE")
if [ -z "$databases" ]; then
    echo "backup.sh: no non-template databases found - unexpected, aborting" >&2
    exit 1
fi
echo "backup.sh: databases to back up: $(echo "$databases" | tr '\n' ' ')"

for db in $databases; do
    echo "backup.sh: pg_dump -Fc ${db}@${PGHOST}:${PGPORT}"
    pgrun pg_dump -Fc -d "$db" -f "$STAGING_DIR/${db}.dump"
done

# Roles/grants live outside any single database. --no-role-passwords:
# role passwords in this stack are (re)applied by supabase's own init
# scripts from .env on a fresh cluster (volumes/db/roles.sql), not by
# replaying this dump, so capturing hashes here would be dead weight.
# Prefer supabase_admin (the actual Postgres superuser in this image) so
# the dump isn't limited by whatever `postgres` can see; fall back to
# $PGUSER if supabase_admin can't authenticate with the same password.
echo "backup.sh: pg_dumpall --globals-only --no-role-passwords"
globals_err="/work/.globals-admin.err"
if pgrun env PGUSER=supabase_admin PGPASSWORD="$PGPASSWORD" pg_dumpall --globals-only --no-role-passwords -f "$STAGING_DIR/globals.sql" 2>"$globals_err"; then
    echo "backup.sh: globals dumped as supabase_admin"
else
    echo "backup.sh: pg_dumpall as supabase_admin failed, falling back to \$PGUSER ($PGUSER):" >&2
    cat "$globals_err" >&2
    pgrun pg_dumpall --globals-only --no-role-passwords -f "$STAGING_DIR/globals.sql"
    echo "backup.sh: globals dumped as $PGUSER"
fi
rm -f "$globals_err"

# ---- restic backup ----------------------------------------------------
echo "backup.sh: restic backup"
backup_json="/work/.restic-backup.json"
set +e
restic backup --json "$STAGING_DIR" "$DB_CONFIG_DIR" --tag pg --tag vibestart --host vibestart | tee "$backup_json"
backup_rc=$?
set -e

SNAPSHOT_ID=$(grep -o '"message_type":"summary"[^}]*"snapshot_id":"[^"]*"' "$backup_json" | grep -o '"snapshot_id":"[^"]*"' | tail -n1 | cut -d'"' -f4)

if [ "$backup_rc" -eq 3 ]; then
    echo "backup.sh: restic backup reported an INCOMPLETE snapshot (exit 3 - some source file could not be read)" >&2
    if [ -n "$SNAPSHOT_ID" ]; then
        echo "backup.sh: quarantining incomplete snapshot $SNAPSHOT_ID" >&2
        restic forget "$SNAPSHOT_ID" || echo "backup.sh: WARNING - failed to forget quarantined snapshot $SNAPSHOT_ID" >&2
    fi
    rm -f "$backup_json"
    exit 1
elif [ "$backup_rc" -ne 0 ]; then
    echo "backup.sh: restic backup failed (exit $backup_rc)" >&2
    rm -f "$backup_json"
    exit "$backup_rc"
fi
rm -f "$backup_json"

if [ -z "$SNAPSHOT_ID" ]; then
    echo "backup.sh: restic backup exited 0 but no snapshot_id was parsed from its --json output - aborting" >&2
    exit 1
fi
echo "backup.sh: snapshot $SNAPSHOT_ID created"

quarantine_and_fail() {
    echo "backup.sh: $1 - quarantining unverified snapshot $SNAPSHOT_ID" >&2
    restic forget "$SNAPSHOT_ID" || echo "backup.sh: WARNING - failed to forget quarantined snapshot $SNAPSHOT_ID" >&2
    exit 1
}

# ---- weekly (by default) full repository integrity check ------------------
run_check=0
case "$RESTIC_CHECK" in
    always) run_check=1 ;;
    weekly) [ "$(date +%u)" = "7" ] && run_check=1 ;; # ISO: 7 = Sunday
    never) run_check=0 ;;
esac
if [ "$run_check" -eq 1 ]; then
    echo "backup.sh: restic check"
    restic check || quarantine_and_fail "restic check failed"
else
    echo "backup.sh: skipping restic check (RESTIC_CHECK=$RESTIC_CHECK, not due today)"
fi

# ---- manifest-presence check: every expected file actually reached the ----
# ---- repository, verified against the repo itself (not just local intent).
echo "backup.sh: verifying manifest of snapshot $SNAPSHOT_ID via restic ls"
listing=$(restic ls "$SNAPSHOT_ID" --host vibestart 2>&1) || quarantine_and_fail "restic ls failed"

missing=0
for db in $databases; do
    case "$listing" in
        *"${STAGING_DIR}/${db}.dump"*) ;;
        *) echo "backup.sh: MISSING ${db}.dump in snapshot $SNAPSHOT_ID" >&2; missing=1 ;;
    esac
done
case "$listing" in
    *"${STAGING_DIR}/globals.sql"*) ;;
    *) echo "backup.sh: MISSING globals.sql in snapshot $SNAPSHOT_ID" >&2; missing=1 ;;
esac
case "$listing" in
    *"${DB_CONFIG_DIR}"*) ;;
    *) echo "backup.sh: MISSING $DB_CONFIG_DIR contents in snapshot $SNAPSHOT_ID" >&2; missing=1 ;;
esac
[ "$missing" -eq 0 ] || quarantine_and_fail "manifest is incomplete"
echo "backup.sh: manifest verified - all expected dumps + globals.sql + db-config present"

# ---- tag verified -----------------------------------------------------
# restic tag creates a NEW snapshot object in place of the old one (tags
# are content-addressed, so tagging changes the id) and removes the
# pre-tag object as part of the same operation - confirmed directly: a
# `restic forget` on the pre-tag id afterwards fails with "key does not
# exist", not "already gone but harmless". $SNAPSHOT_ID above is only
# ever used for the checks that must happen *before* this line.
echo "backup.sh: tagging snapshot $SNAPSHOT_ID as verified"
restic tag --add verified "$SNAPSHOT_ID"

# ---- retention (runs only after verification) --------------------------
# --group-by host,tags (not the default host,paths): fixed STAGING_DIR
# above already keeps recorded paths stable, this is belt-and-suspenders
# so retention buckets never silently split by path again.
echo "backup.sh: restic forget --prune (keep daily=$KEEP_DAILY weekly=$KEEP_WEEKLY monthly=$KEEP_MONTHLY)"
restic forget --prune \
    --tag pg,vibestart \
    --group-by host,tags \
    --keep-daily "$KEEP_DAILY" \
    --keep-weekly "$KEEP_WEEKLY" \
    --keep-monthly "$KEEP_MONTHLY"

STATUS=0
echo "backup.sh: done"
if [ -n "${HEARTBEAT_URL:-}" ]; then
    if curl -fsS -m 10 --retry 3 "$HEARTBEAT_URL" >/dev/null 2>&1; then
        echo "backup.sh: success heartbeat sent"
    else
        echo "backup.sh: success heartbeat FAILED to send" >&2
    fi
fi
