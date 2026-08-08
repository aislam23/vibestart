# vibestart operator console. Run `make` or `make help` for the target list.
#
# Every target works from any cwd (paths are anchored to this file's
# directory via ROOT_DIR), so `cd infra/edge && make -C ../.. status` works
# the same as running `make status` from the repo root.

SHELL := /bin/bash

ROOT_DIR := $(abspath $(dir $(lastword $(MAKEFILE_LIST))))
SUPABASE_DIR := $(ROOT_DIR)/infra/supabase
EDGE_DIR := $(ROOT_DIR)/infra/edge
BACKUP_DIR := $(ROOT_DIR)/infra/backup
APP_DIR := $(ROOT_DIR)/infra/app
BACKUP_COMPOSE := docker compose -f "$(BACKUP_DIR)/docker-compose.yml"
APP_COMPOSE := docker compose -f "$(APP_DIR)/docker-compose.yml"

.DEFAULT_GOAL := help

.PHONY: help
help: ## Show this help
	@grep -hE '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}'

.PHONY: secrets
secrets: ## Generate infra/supabase/.env for local dev (refuses to overwrite an existing file)
	cd "$(ROOT_DIR)" && bun run secrets:generate

.PHONY: secrets-prod
secrets-prod: ## Generate infra/supabase/.env for production (bun infra/supabase/generate-secrets.ts --prod); pass extra flags via ARGS="--site-url=... --api-external-url=... --public-url=..."
	cd "$(ROOT_DIR)" && bun infra/supabase/generate-secrets.ts --prod $(ARGS)

.PHONY: ensure-network
ensure-network: ## Create the shared `edge`/`app_edge` Docker networks if they don't already exist
	@docker network inspect edge >/dev/null 2>&1 || docker network create edge
	@docker network inspect app_edge >/dev/null 2>&1 || docker network create app_edge

.PHONY: supabase-up
supabase-up: ensure-network ## Start the Supabase stack
	cd "$(SUPABASE_DIR)" && docker compose up -d

.PHONY: supabase-down
supabase-down: ## Stop the Supabase stack (keeps volumes - never -v here)
	cd "$(SUPABASE_DIR)" && docker compose down

.PHONY: supabase-logs
supabase-logs: ## Tail logs for the Supabase stack
	cd "$(SUPABASE_DIR)" && docker compose logs -f

.PHONY: edge-up
edge-up: ensure-network ## Start the Caddy edge stack
	@mkdir -p "$(ROOT_DIR)/releases"
	cd "$(EDGE_DIR)" && docker compose up -d

.PHONY: edge-down
edge-down: ## Stop the Caddy edge stack (keeps volumes - never -v here)
	cd "$(EDGE_DIR)" && docker compose down

.PHONY: app-up
app-up: ensure-network ## Start the backend production stack (infra/app)
	cd "$(APP_DIR)" && docker compose up -d

.PHONY: app-down
app-down: ## Stop the backend production stack
	cd "$(APP_DIR)" && docker compose down

.PHONY: app-logs
app-logs: ## Tail logs for the backend production stack
	cd "$(APP_DIR)" && docker compose logs -f

.PHONY: app-migrate
app-migrate: ## Apply backend/prisma/migrations against MIGRATE_DATABASE_URL (see infra/app/README.md)
	$(APP_COMPOSE) run --rm migrate

# up/down use $(MAKE) calls in a single recipe body (not prerequisites) so
# the steps run strictly sequentially even under `make -j` - prerequisites
# are allowed to parallelize, a single recipe's lines never are. Order:
# network -> supabase -> app -> edge (app-migrate is deliberately not part
# of this chain - a schema migration is never something `make up` should
# run silently on every start; run `make app-migrate` by hand, see
# infra/app/README.md, "First deploy").
.PHONY: up
up: ## Start all stacks (supabase, then app, then edge)
	@$(MAKE) ensure-network
	@$(MAKE) supabase-up
	@$(MAKE) app-up
	@$(MAKE) edge-up

.PHONY: down
down: ## Stop all stacks (edge, then app, then supabase - reverse of up)
	@$(MAKE) edge-down
	@$(MAKE) app-down
	@$(MAKE) supabase-down

.PHONY: status
status: ## Show container status for all stacks + docker volume disk usage
	@echo "== supabase =="
	@out=$$(cd "$(SUPABASE_DIR)" && docker compose ps 2>&1); code=$$?; \
	  if [ $$code -ne 0 ]; then echo "warning: $$out"; else echo "$$out"; fi
	@echo "== app =="
	@out=$$(cd "$(APP_DIR)" && docker compose ps 2>&1); code=$$?; \
	  if [ $$code -ne 0 ]; then echo "warning: $$out"; else echo "$$out"; fi
	@echo "== edge =="
	@out=$$(cd "$(EDGE_DIR)" && docker compose ps 2>&1); code=$$?; \
	  if [ $$code -ne 0 ]; then echo "warning: $$out"; else echo "$$out"; fi
	@echo "== backup =="
	@out=$$($(BACKUP_COMPOSE) ps 2>&1); code=$$?; \
	  if [ $$code -ne 0 ]; then echo "warning: $$out"; else echo "$$out"; fi
	@echo "== docker volumes disk usage =="
	@docker system df | grep -E '^TYPE|^Local Volumes' || docker system df

.PHONY: test
test: ## Run the test suite (bun run test)
	cd "$(ROOT_DIR)" && bun run test

.PHONY: typecheck
typecheck: ## Run typechecking across workspaces (bun run typecheck)
	cd "$(ROOT_DIR)" && bun run typecheck

.PHONY: backup
backup: ## Run a one-shot Postgres backup to S3 now (see infra/backup)
	$(BACKUP_COMPOSE) run --rm backup /usr/local/bin/backup.sh

.PHONY: restore
restore: ## List available backup snapshots - see infra/backup/README.md for the actual restore command (never automatic)
	@echo "restore is never automatic — read infra/backup/README.md 'Restore procedure', then run:" >&2
	@echo "  docker compose -f infra/backup/docker-compose.yml run --rm backup /usr/local/bin/restore.sh restore latest --yes" >&2
	@echo "" >&2
	$(BACKUP_COMPOSE) run --rm backup /usr/local/bin/restore.sh list

.PHONY: backup-up
backup-up: ## Start the scheduled backup crond service
	$(BACKUP_COMPOSE) up -d

.PHONY: backup-down
backup-down: ## Stop the scheduled backup crond service
	$(BACKUP_COMPOSE) down

# Volume names are fixed by infra/supabase's compose project name
# (`name: supabase`), not by however this Makefile is invoked - confirmed
# via `docker compose config` in infra/supabase (resolves to
# supabase_db-data / supabase_db-config regardless of cwd).
PRE_RESTORE_DIR := $(ROOT_DIR)/backups

.PHONY: pre-restore-snapshot
pre-restore-snapshot: ## Host-side safety net before a restore: tar db-data+db-config to backups/pre-restore-<ts>.tar.gz
	@mkdir -p "$(PRE_RESTORE_DIR)"
	@ts=$$(date +%Y%m%d-%H%M%S); \
	echo "pre-restore-snapshot: this is a best-effort raw volume copy taken while supabase-db"; \
	echo "pre-restore-snapshot: keeps running (consistent with restore.sh's own runbook, which"; \
	echo "pre-restore-snapshot: needs db up to reconnect). For a guaranteed-consistent copy, stop"; \
	echo "pre-restore-snapshot: it first: docker compose -f infra/supabase/docker-compose.yml stop db"; \
	docker run --rm \
	  -v supabase_db-data:/src/db-data:ro \
	  -v supabase_db-config:/src/db-config:ro \
	  -v "$(PRE_RESTORE_DIR):/dest" \
	  alpine:3.22 \
	  tar czf "/dest/pre-restore-$$ts.tar.gz" -C /src db-data db-config; \
	echo "pre-restore-snapshot: wrote $(PRE_RESTORE_DIR)/pre-restore-$$ts.tar.gz"; \
	echo "pre-restore-snapshot: rollback command (stop supabase-db first: docker compose -f infra/supabase/docker-compose.yml stop db):"; \
	echo "  docker run --rm -v supabase_db-data:/dest/db-data -v supabase_db-config:/dest/db-config -v $(PRE_RESTORE_DIR):/src alpine:3.22 sh -c 'rm -rf /dest/db-data/* /dest/db-config/* && tar xzf /src/pre-restore-$$ts.tar.gz -C /dest'"

.PHONY: deploy
deploy: ## Deploy is not a local Makefile target - see .github/workflows/deploy.yml
	@echo "deploy runs in CI, not locally - push a v* tag or trigger .github/workflows/deploy.yml manually (workflow_dispatch)." >&2
	@echo "See .github/workflows/README.md for the required secrets/vars, and infra/app/README.md for the manual equivalent (app-migrate + app-up)." >&2
	@exit 1
