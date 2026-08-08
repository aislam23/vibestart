#!/bin/sh
# Restore runbook. Runs as the unprivileged `backup` user (entrypoint.sh
# drops via su-exec). Read infra/backup/README.md "Restore procedure"
# before running this for real - restoring is destructive.
#
# Usage:
#   restore.sh list
#   restore.sh restore [SNAPSHOT] [--yes] [--with-globals]
#
# Without --yes: downloads and structurally verifies every dump only
# (safe, no database touched). With --yes: OVERWRITES the matching
# database for every <datname>.dump found in the snapshot, and also
# requires RESTORE_ACK=yes in the environment (two-step confirmation -
# see the checklist printed below).
set -euo pipefail

: "${PGHOST:=db}"
: "${PGPORT:=54322}"
: "${PGUSER:=postgres}"
: "${PGDATABASE:=postgres}"
: "${S3_PATH:=vibestart/postgres}"
: "${RESTIC_TIMEOUT:=1800}" # seconds; hard cap per restic invocation
: "${PG_TIMEOUT:=3600}"     # seconds; hard cap per psql/pg_restore call
: "${LOCK_FILE:=/work/backup.lock}"

WORKDIR=""
LOCK_HELD=0

cleanup() {
    if [ "$LOCK_HELD" -eq 1 ]; then
        flock -u 9 2>/dev/null || true
    fi
    [ -n "$WORKDIR" ] && rm -rf "$WORKDIR" 2>/dev/null || true
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

# See backup.sh for why: restic's own retry/backoff on backend errors has
# no cap, so a bad credential or unreachable endpoint can otherwise hang.
restic() { command timeout -k 30 "$RESTIC_TIMEOUT" restic "$@"; }
pgrun() { command timeout -k 30 "$PG_TIMEOUT" "$@"; }

# ---- exclusive lock: shared with backup.sh so a scheduled backup can ----
# ---- never run concurrently with a restore (or two restores at once).
mkdir -p "$(dirname "$LOCK_FILE")"
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
    echo "restore.sh: another backup/restore is already running (lock held: $LOCK_FILE) - aborting" >&2
    exit 1
fi
LOCK_HELD=1

usage() {
    cat >&2 <<EOF
Usage:
  restore.sh list                                     List available snapshots
  restore.sh restore [SNAPSHOT] [--yes] [--with-globals]
      SNAPSHOT defaults to "latest", which only ever resolves to a
      snapshot tagged "verified" - pass an explicit ID (from 'list') to
      restore an unverified one; you'll get a warning when you do.
      Without --yes: downloads + verifies every dump only (dry run, safe).
      With --yes: OVERWRITES the matching database for each <datname>.dump
      found in the snapshot on \$PGHOST:\$PGPORT. Also requires
      RESTORE_ACK=yes in the environment - see the printed checklist.
      --with-globals: also applies globals.sql (roles) - only useful when
      restoring into a fresh cluster; on an existing supabase stack the
      roles already exist and per-role errors there are expected (see
      README.md).
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
        echo " snapshot: $snapshot  ->  ${PGUSER}@${PGHOST}:${PGPORT} (every <datname>.dump found)"
        echo " This OVERWRITES the matching database(s) when run with --yes."
        echo " STOP the backend and any other writer BEFORE using --yes -"
        echo " a live writer during pg_restore corrupts the result."
        echo "=============================================================="

        if [ "$snapshot" = "latest" ]; then
            restic_filter="--tag verified"
        else
            restic_filter=""
            snap_json=$(restic snapshots "$snapshot" --host vibestart --json 2>/dev/null || echo '[]')
            case "$snap_json" in
                '[]'|'')
                    echo "restore.sh: snapshot '$snapshot' not found (host vibestart)" >&2
                    exit 1
                    ;;
            esac
            case "$snap_json" in
                *'"verified"'*) ;;
                *)
                    echo "restore.sh: WARNING - snapshot $snapshot does NOT carry the 'verified' tag" >&2
                    echo "restore.sh: (it may be incomplete or was never checked). Proceeding anyway" >&2
                    echo "restore.sh: since it was explicitly requested." >&2
                    ;;
            esac
        fi

        WORKDIR="$(mktemp -d /work/restore.XXXXXX)"

        echo "restore.sh: downloading snapshot $snapshot to $WORKDIR"
        set +e
        # shellcheck disable=SC2086
        restic restore "$snapshot" $restic_filter --host vibestart --target "$WORKDIR"
        restore_dl_rc=$?
        set -e
        if [ "$restore_dl_rc" -ne 0 ]; then
            if [ "$snapshot" = "latest" ]; then
                echo "restore.sh: no verified snapshot exists yet for host vibestart." >&2
                echo "restore.sh: run 'restore.sh list' and pass an explicit snapshot ID if you must restore an unverified one." >&2
            fi
            exit "$restore_dl_rc"
        fi

        dump_files=$(find "$WORKDIR" -name '*.dump' | sort)
        globals_file=$(find "$WORKDIR" -name globals.sql | head -n1)
        dbconfig_dir=$(find "$WORKDIR" -type d -name db-config 2>/dev/null | head -n1)

        if [ -z "$dump_files" ]; then
            echo "restore.sh: no *.dump files found inside snapshot $snapshot" >&2
            exit 1
        fi

        echo "restore.sh: verifying dump structure (pg_restore --list) for each database"
        for f in $dump_files; do
            name=$(basename "$f" .dump)
            toc="$WORKDIR/.pg_restore_list.$name"
            pgrun pg_restore --list "$f" >"$toc"
            echo "restore.sh:   $name: $(wc -l <"$toc") TOC entries - OK"
        done

        if [ -n "$dbconfig_dir" ]; then
            echo "restore.sh: db-config (pgsodium root key) present in snapshot at $dbconfig_dir"
            echo "restore.sh: restoring it into the live db-config Docker volume is a manual, host-level"
            echo "restore.sh: step (this container only ever has read-only access to that volume) - see"
            echo "restore.sh: README.md 'Restoring the pgsodium key (db-config)' if that volume itself was lost."
        else
            echo "restore.sh: WARNING - no db-config directory in this snapshot (older snapshot from before it was included?)" >&2
        fi

        if [ "$confirm" -ne 1 ]; then
            echo "restore.sh: dry run only (no --yes) - downloaded and verified at:"
            for f in $dump_files; do echo "  $f"; done
            [ -n "$globals_file" ] && echo "  $globals_file"
            echo "restore.sh: re-run with --yes (and RESTORE_ACK=yes) to actually restore"
            exit 0
        fi

        cat >&2 <<'EOF'
==================== PRE-RESTORE CHECKLIST ====================
Before this proceeds, confirm ALL of the following are true:
  [ ] Dependent services (backend, migrations, anything else writing to
      this database) are STOPPED.
  [ ] A pre-restore safety snapshot was taken:
        make pre-restore-snapshot
      (tars db-data + db-config to backups/pre-restore-<ts>.tar.gz on the
      host - this is your rollback path if the restore goes wrong.)
  [ ] You've read infra/backup/README.md "Restore procedure" end to end.
Proceeding also requires RESTORE_ACK=yes in the environment, in addition
to --yes (two-step confirmation - this is deliberately not just a flag).
=================================================================
EOF
        if [ "${RESTORE_ACK:-}" != "yes" ]; then
            echo "restore.sh: RESTORE_ACK=yes is not set - aborting. Re-run with e.g.:" >&2
            echo "restore.sh:   docker compose -f infra/backup/docker-compose.yml run --rm -e RESTORE_ACK=yes \\" >&2
            echo "restore.sh:     backup /usr/local/bin/restore.sh restore $snapshot --yes" >&2
            exit 1
        fi

        echo "restore.sh: checklist acknowledged (RESTORE_ACK=yes) - applying in 5s (Ctrl+C to abort)"
        sleep 5

        if [ "$with_globals" -eq 1 ]; then
            if [ -n "$globals_file" ]; then
                echo "restore.sh: applying globals.sql (roles) via psql -X (no error suppression - a real"
                echo "restore.sh: connection/parse failure now aborts this script; per-role 'already exists'"
                echo "restore.sh: errors on an existing cluster are expected and do not, by themselves, make"
                echo "restore.sh: psql exit non-zero)."
                pgrun psql -X -d postgres -f "$globals_file"
            else
                echo "restore.sh: --with-globals given but globals.sql not found in snapshot, skipping" >&2
            fi
        fi

        overall_rc=0
        for f in $dump_files; do
            db=$(basename "$f" .dump)
            echo "restore.sh: pg_restore --clean --if-exists -d $db"
            set +e
            pgrun pg_restore --clean --if-exists -d "$db" "$f"
            db_rc=$?
            set -e
            if [ "$db_rc" -ne 0 ]; then
                overall_rc="$db_rc"
                cat >&2 <<EOF

restore.sh: pg_restore reported errors above for database "$db" (exit $db_rc).
restore.sh: EXPECTED when restoring in-place into a self-hosted Supabase
restore.sh: database: the "postgres" role there is not a true superuser
restore.sh: (supabase_admin is), so it cannot re-create Supabase-internal
restore.sh: objects (schemas/extensions/event triggers/auth.* tables)
restore.sh: that already exist in the target - those are skipped
restore.sh: harmlessly. Check the output above for errors on YOUR OWN
restore.sh: schema/tables (not auth/storage/realtime/extensions/vault/
restore.sh: pgbouncer/graphql*/_realtime/supabase_functions) - those
restore.sh: would indicate a real problem. The only real acceptance
restore.sh: criterion is your own application-data verification queries
restore.sh: (README.md "Restore procedure") - if in doubt, roll back.
EOF
            fi
        done

        echo "restore.sh: restore complete - verify application data before resuming dependent services"
        exit "$overall_rc"
        ;;
    *)
        usage
        ;;
esac
