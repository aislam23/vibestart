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
set -eu

if [ $# -eq 0 ] || [ "$1" = "crond" ]; then
    cron_expr="${BACKUP_CRON:-30 3 * * *}"
    mkdir -p /etc/crontabs
    # su-exec drops root -> backup before backup.sh ever runs; crond itself
    # never reads POSTGRES_PASSWORD/RESTIC_PASSWORD or touches the network.
    echo "$cron_expr su-exec backup /usr/local/bin/backup.sh >>/proc/1/fd/1 2>>/proc/1/fd/2" > /etc/crontabs/root
    echo "entrypoint: scheduling backup.sh with cron expression: $cron_expr"
    exec crond -f -l 8 -L /dev/stdout
fi

exec su-exec backup "$@"
