# Backup runner: pg_dump (matches db's Postgres 17 major) + restic, driven
# by cron inside the container. See README.md for the full runbook.
#
# alpine:3.22 ships postgresql17-client-17.10-r0 (major matches
# infra/supabase's supabase/postgres:17.6.1.136) and restic-0.18.0-r7 -
# verified via `apk info postgresql17-client restic` against this tag.
FROM alpine:3.22

RUN apk add --no-cache \
        postgresql17-client \
        restic \
        curl \
        tzdata \
        su-exec \
    && addgroup -S backup \
    && adduser -S -G backup -h /home/backup backup \
    && mkdir -p /var/cache/restic /home/backup /work \
    && chown -R backup:backup /var/cache/restic /home/backup /work

COPY backup.sh /usr/local/bin/backup.sh
COPY restore.sh /usr/local/bin/restore.sh
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/backup.sh /usr/local/bin/restore.sh /usr/local/bin/entrypoint.sh

ENV RESTIC_CACHE_DIR=/var/cache/restic
WORKDIR /work

# Stays root: busybox crond needs root to run as a long-lived scheduler
# (see README "Why crond runs as root"). It never touches secrets or the
# network itself - every scheduled job drops to the unprivileged `backup`
# user via su-exec before running backup.sh/restore.sh, which do all the
# actual work (reading POSTGRES_PASSWORD/RESTIC_PASSWORD, talking to db
# and S3). One-shot `docker compose run` invocations also go through
# entrypoint.sh's su-exec drop.
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
