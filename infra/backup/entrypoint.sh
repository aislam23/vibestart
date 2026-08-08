#!/bin/sh
# Container entrypoint. Two modes:
#
#   (no args, or "crond")  -> generate a crontab from $BACKUP_CRON and run
#                              busybox crond in the foreground (the
#                              `backup` compose service). Stays root only
#                              to run crond itself; the scheduled job drops
#                              to the unprivileged `backup` user.
#   (any other command)    -> one-shot mode: drop to `backup` and exec the
#                              given command directly (used by
#                              `docker compose run --rm backup backup.sh`
#                              and `... restore.sh ...`).
#
# Validates BACKUP_CRON and RESTIC_CHECK before doing anything else, in
# both modes: BACKUP_CRON is about to be written verbatim into a root
# crontab, and a bad RESTIC_CHECK would otherwise only be discovered deep
# inside backup.sh at 3am instead of at `docker compose up`/`run` time.
set -eu

: "${RESTIC_CHECK:=weekly}"
case "$RESTIC_CHECK" in
    weekly|always|never) ;;
    *)
        echo "entrypoint: RESTIC_CHECK must be one of weekly|always|never, got '$RESTIC_CHECK' - refusing to start" >&2
        exit 1
        ;;
esac

cron_expr="${BACKUP_CRON:-30 3 * * *}"
# wc -l against a string we ourselves terminated with exactly one newline:
# this is >1 iff $cron_expr itself contains an embedded newline. (Can't
# use `case "$x" in *"$(printf '\n')"*)` for this - command substitution
# strips the trailing newline, silently turning that into an always-match
# empty pattern.) Multi-line input matters here specifically because the
# regex check below uses `grep -q`, which matches if ANY line matches -
# without this check first, a crafted "30 3 * * *\n0 0 * * * rm -rf /"
# would sail through as a valid single 5-field line.
if [ "$(printf '%s\n' "$cron_expr" | wc -l)" -ne 1 ]; then
    echo "entrypoint: BACKUP_CRON contains multiple lines - refusing to start" >&2
    exit 1
fi
# Strict 5-field cron: digits/*/,/-// only per field, exactly 5 fields.
# Deliberately rejects named months/days (JAN, MON, ...) and anything else
# that isn't plain numeric cron syntax - this string is about to be
# written verbatim into a root crontab line, so "strict" here means
# "cannot smuggle in extra crontab lines or shell metacharacters", not
# full cron grammar coverage.
cron_field='[0-9*/,-]+'
if ! printf '%s' "$cron_expr" | grep -Eq "^${cron_field} ${cron_field} ${cron_field} ${cron_field} ${cron_field}\$"; then
    echo "entrypoint: BACKUP_CRON '$cron_expr' is not a strict 5-field numeric cron expression - refusing to start" >&2
    exit 1
fi

if [ -z "${HEARTBEAT_URL:-}" ]; then
    cat >&2 <<'EOF'
entrypoint: ==================================================
entrypoint: WARNING: HEARTBEAT_URL is not set - backups are UNMONITORED.
entrypoint: A silent backup failure will look like silence, not an
entrypoint: incident. Set HEARTBEAT_URL before relying on this in
entrypoint: production - see README.md "Heartbeat setup".
entrypoint: ==================================================
EOF
fi

if [ $# -eq 0 ] || [ "$1" = "crond" ]; then
    mkdir -p /etc/crontabs
    # su-exec drops root -> backup before backup.sh ever runs, but crond
    # itself DOES inherit the full container environment (including
    # PGPASSWORD/RESTIC_PASSWORD) for the jobs it spawns - busybox crond
    # does not clear or filter env vars, verified directly. su-exec's
    # privilege drop limits *file/process* access for the job (uid/gid),
    # it does not hide environment variables from it - the job would see
    # secrets either way; the actual protection here is that nothing
    # other than backup.sh/restore.sh runs in this container at all.
    echo "$cron_expr su-exec backup /usr/local/bin/backup.sh >>/proc/1/fd/1 2>>/proc/1/fd/2" > /etc/crontabs/root
    echo "entrypoint: scheduling backup.sh with cron expression: $cron_expr"
    exec crond -f -l 8 -L /dev/stdout
fi

exec su-exec backup "$@"
