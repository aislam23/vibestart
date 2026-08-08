#!/bin/sh
# One full backup cycle: pg_dump + pg_dumpall(globals) -> restic backup ->
# prune -> (weekly) integrity check -> heartbeat.
#
# Runs as the unprivileged `backup` user (entrypoint.sh drops via su-exec).
# `set -e` means ANY failed step aborts here; the EXIT trap below only
# pings the success heartbeat when $STATUS was explicitly set to 0 at the
# very end, so every failure path (including a crash mid-script) falls
# through to the failure ping instead - see README "Heartbeat".
set -euo pipefail

: "${PGHOST:=db}"
: "${PGPORT:=54322}"
: "${PGUSER:=postgres}"
: "${PGDATABASE:=postgres}"
: "${KEEP_DAILY:=7}"
: "${KEEP_WEEKLY:=4}"
: "${KEEP_MONTHLY:=6}"
: "${S3_PATH:=vibestart/postgres}"
: "${RESTIC_CHECK:=weekly}" # weekly (Sundays only) | always | never
: "${RESTIC_TIMEOUT:=1800}" # seconds; hard cap per restic invocation - see below

: "${PGPASSWORD:?PGPASSWORD is required - copy POSTGRES_PASSWORD from infra/supabase/.env}"
: "${RESTIC_PASSWORD:?RESTIC_PASSWORD is required - see .env.example}"
: "${S3_ENDPOINT:?S3_ENDPOINT is required}"
: "${S3_BUCKET:?S3_BUCKET is required}"
: "${AWS_ACCESS_KEY_ID:?AWS_ACCESS_KEY_ID is required}"
: "${AWS_SECRET_ACCESS_KEY:?AWS_SECRET_ACCESS_KEY is required}"

export PGHOST PGPORT PGUSER PGDATABASE PGPASSWORD
export RESTIC_PASSWORD AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY
export RESTIC_REPOSITORY="s3:${S3_ENDPOINT}/${S3_BUCKET}/${S3_PATH}"

# restic retries backend I/O errors (including auth failures against a
# misconfigured/rotated S3 key) with its own backoff and no built-in cap,
# so a bad credential can otherwise hang a run indefinitely - past its
# cron window and past the point where the failure heartbeat would ever
# fire. Every restic call below goes through this hard per-call timeout
# instead of a bare `restic` so that class of failure surfaces promptly.
restic() { command timeout "$RESTIC_TIMEOUT" restic "$@"; }

STATUS=1 # flipped to 0 only after every step below has succeeded
WORKDIR="$(mktemp -d /work/backup.XXXXXX)"

cleanup() {
    rc=$?
    rm -rf "$WORKDIR"
    if [ "$rc" -ne 0 ] || [ "$STATUS" -ne 0 ]; then
        echo "backup.sh: FAILED (exit $rc)" >&2
        if [ -n "${HEARTBEAT_URL:-}" ]; then
            curl -fsS -m 10 "${HEARTBEAT_URL%/}/fail" >/dev/null 2>&1 || true
        fi
    fi
}
trap cleanup EXIT INT TERM

echo "backup.sh: pg_dump -Fc ${PGDATABASE}@${PGHOST}:${PGPORT}"
pg_dump -Fc -d "$PGDATABASE" -f "$WORKDIR/postgres.dump"

# Roles/grants live outside any single database. Cheap belt-and-suspenders:
# a fresh `supabase/postgres` init already recreates the standard roles
# (volumes/db/roles.sql), but this captures anything added after init.
echo "backup.sh: pg_dumpall --globals-only"
pg_dumpall --globals-only -f "$WORKDIR/globals.sql"

if ! restic snapshots >/dev/null 2>&1; then
    echo "backup.sh: restic repo not found, running restic init"
    restic init
fi

echo "backup.sh: restic backup"
restic backup "$WORKDIR" --tag pg --tag vibestart --host vibestart

echo "backup.sh: restic forget --prune (keep daily=$KEEP_DAILY weekly=$KEEP_WEEKLY monthly=$KEEP_MONTHLY)"
restic forget --prune \
    --tag pg,vibestart \
    --keep-daily "$KEEP_DAILY" \
    --keep-weekly "$KEEP_WEEKLY" \
    --keep-monthly "$KEEP_MONTHLY"

run_check=0
case "$RESTIC_CHECK" in
    always) run_check=1 ;;
    weekly) [ "$(date +%u)" = "7" ] && run_check=1 ;; # ISO: 7 = Sunday
    never) run_check=0 ;;
esac
if [ "$run_check" -eq 1 ]; then
    echo "backup.sh: restic check"
    restic check
else
    echo "backup.sh: skipping restic check (RESTIC_CHECK=$RESTIC_CHECK, not due today)"
fi

STATUS=0
echo "backup.sh: done"
if [ -n "${HEARTBEAT_URL:-}" ]; then
    curl -fsS -m 10 "$HEARTBEAT_URL" >/dev/null 2>&1 || true
fi
