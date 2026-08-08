#!/bin/sh
# Restore runbook. Runs as the unprivileged `backup` user (entrypoint.sh
# drops via su-exec). Read infra/backup/README.md "Restore procedure"
# before running this for real - restoring is destructive.
#
# Usage:
#   restore.sh list
#   restore.sh restore [SNAPSHOT] [--yes] [--with-globals]
#
# Without --yes: downloads and structurally verifies the dump only (safe,
# no database touched). With --yes: OVERWRITES the current database.
set -euo pipefail

: "${PGHOST:=db}"
: "${PGPORT:=54322}"
: "${PGUSER:=postgres}"
: "${PGDATABASE:=postgres}"
: "${S3_PATH:=vibestart/postgres}"
: "${RESTIC_TIMEOUT:=1800}" # seconds; hard cap per restic invocation

: "${PGPASSWORD:?PGPASSWORD is required - copy POSTGRES_PASSWORD from infra/supabase/.env}"
: "${RESTIC_PASSWORD:?RESTIC_PASSWORD is required - see .env.example}"
: "${S3_ENDPOINT:?S3_ENDPOINT is required}"
: "${S3_BUCKET:?S3_BUCKET is required}"
: "${AWS_ACCESS_KEY_ID:?AWS_ACCESS_KEY_ID is required}"
: "${AWS_SECRET_ACCESS_KEY:?AWS_SECRET_ACCESS_KEY is required}"

export PGHOST PGPORT PGUSER PGDATABASE PGPASSWORD
export RESTIC_PASSWORD AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY
export RESTIC_REPOSITORY="s3:${S3_ENDPOINT}/${S3_BUCKET}/${S3_PATH}"

# See backup.sh for why: restic's own retry/backoff on backend errors has
# no cap, so a bad credential or unreachable endpoint can otherwise hang.
restic() { command timeout "$RESTIC_TIMEOUT" restic "$@"; }

usage() {
    cat >&2 <<EOF
Usage:
  restore.sh list                                     List available snapshots
  restore.sh restore [SNAPSHOT] [--yes] [--with-globals]
      SNAPSHOT defaults to "latest".
      Without --yes: downloads + verifies the dump only (dry run, safe).
      With --yes: OVERWRITES the current \$PGDATABASE on \$PGHOST:\$PGPORT.
      --with-globals: also applies globals.sql (roles) - only useful when
      restoring into a fresh cluster; on an existing supabase stack the
      roles already exist and this is a no-op (errors are swallowed).
EOF
    exit 1
}

cmd="${1:-}"
[ -n "$cmd" ] || usage
shift

case "$cmd" in
    list)
        restic snapshots --host vibestart
        ;;
    restore)
        snapshot="latest"
        confirm=0
        with_globals=0
        while [ $# -gt 0 ]; do
            case "$1" in
                --yes) confirm=1 ;;
                --with-globals) with_globals=1 ;;
                -*) usage ;;
                *) snapshot="$1" ;;
            esac
            shift
        done

        echo "=============================================================="
        echo " RESTORE RUNBOOK"
        echo " snapshot: $snapshot  ->  ${PGUSER}@${PGHOST}:${PGPORT}/${PGDATABASE}"
        echo " This OVERWRITES the current database when run with --yes."
        echo " STOP the backend and any other writer BEFORE using --yes -"
        echo " a live writer during pg_restore corrupts the result."
        echo "=============================================================="

        WORKDIR="$(mktemp -d /work/restore.XXXXXX)"
        trap 'rm -rf "$WORKDIR"' EXIT

        echo "restore.sh: downloading snapshot $snapshot to $WORKDIR"
        restic restore "$snapshot" --host vibestart --target "$WORKDIR"

        dump_file=$(find "$WORKDIR" -name postgres.dump | head -n1)
        globals_file=$(find "$WORKDIR" -name globals.sql | head -n1)
        if [ -z "$dump_file" ]; then
            echo "restore.sh: postgres.dump not found inside snapshot $snapshot" >&2
            exit 1
        fi

        echo "restore.sh: verifying dump structure (pg_restore --list)"
        toc="$WORKDIR/.pg_restore_list"
        pg_restore --list "$dump_file" >"$toc"
        cat "$toc"
        echo "restore.sh: dump verified - $(wc -l <"$toc") TOC entries"

        if [ "$confirm" -ne 1 ]; then
            echo "restore.sh: dry run only (no --yes) - dump downloaded and verified at:"
            echo "  $dump_file"
            [ -n "$globals_file" ] && echo "  $globals_file"
            echo "restore.sh: re-run with --yes to actually restore into $PGDATABASE"
            exit 0
        fi

        echo "restore.sh: --yes given - applying to ${PGHOST}:${PGPORT}/${PGDATABASE} in 5s (Ctrl+C to abort)"
        sleep 5

        if [ "$with_globals" -eq 1 ]; then
            if [ -n "$globals_file" ]; then
                echo "restore.sh: applying globals.sql (roles) - errors on already-existing roles are expected"
                psql -d postgres -f "$globals_file" || true
            else
                echo "restore.sh: --with-globals given but globals.sql not found in snapshot, skipping" >&2
            fi
        fi

        echo "restore.sh: pg_restore --clean --if-exists -d $PGDATABASE"
        set +e
        pg_restore --clean --if-exists -d "$PGDATABASE" "$dump_file"
        restore_rc=$?
        set -e

        if [ "$restore_rc" -ne 0 ]; then
            cat >&2 <<EOF

restore.sh: pg_restore reported errors above (exit $restore_rc).
restore.sh: EXPECTED when restoring in-place into a self-hosted Supabase
restore.sh: database: the "postgres" role there is not a true superuser
restore.sh: (supabase_admin is), so it cannot re-create Supabase-internal
restore.sh: objects (schemas/extensions/event triggers/auth.* tables)
restore.sh: that already exist in the target - those are skipped
restore.sh: harmlessly. Check the output above for errors on YOUR OWN
restore.sh: schema/tables (not auth/storage/realtime/extensions/vault/
restore.sh: pgbouncer/graphql*/_realtime/supabase_functions) - those
restore.sh: would indicate a real problem.
EOF
            exit "$restore_rc"
        fi

        echo "restore.sh: restore complete - verify the app before resuming dependent services"
        ;;
    *)
        usage
        ;;
esac
