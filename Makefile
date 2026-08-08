# vibestart operator console. Run `make` or `make help` for the target list.
#
# Every target works from any cwd (paths are anchored to this file's
# directory via ROOT_DIR), so `cd infra/edge && make -C ../.. status` works
# the same as running `make status` from the repo root.

SHELL := /bin/bash

ROOT_DIR := $(abspath $(dir $(lastword $(MAKEFILE_LIST))))
SUPABASE_DIR := $(ROOT_DIR)/infra/supabase
EDGE_DIR := $(ROOT_DIR)/infra/edge

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
ensure-network: ## Create the shared `edge` Docker network if it doesn't already exist
	@docker network inspect edge >/dev/null 2>&1 || docker network create edge

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
	@mkdir -p "$(ROOT_DIR)/webapp/dist" "$(ROOT_DIR)/website/dist"
	cd "$(EDGE_DIR)" && docker compose up -d

.PHONY: edge-down
edge-down: ## Stop the Caddy edge stack (keeps volumes - never -v here)
	cd "$(EDGE_DIR)" && docker compose down

# up/down use $(MAKE) calls in a single recipe body (not prerequisites) so
# the steps run strictly sequentially even under `make -j` - prerequisites
# are allowed to parallelize, a single recipe's lines never are.
.PHONY: up
up: ## Start both stacks (supabase, then edge)
	@$(MAKE) ensure-network
	@$(MAKE) supabase-up
	@$(MAKE) edge-up

.PHONY: down
down: ## Stop both stacks (edge, then supabase - reverse of up)
	@$(MAKE) edge-down
	@$(MAKE) supabase-down

.PHONY: status
status: ## Show container status for both stacks + docker volume disk usage
	@echo "== supabase =="
	@out=$$(cd "$(SUPABASE_DIR)" && docker compose ps 2>&1); code=$$?; \
	  if [ $$code -ne 0 ]; then echo "warning: $$out"; else echo "$$out"; fi
	@echo "== edge =="
	@out=$$(cd "$(EDGE_DIR)" && docker compose ps 2>&1); code=$$?; \
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
backup: ## [not implemented] Trigger a Supabase backup - see infra/backup (T4)
	@echo "not implemented yet — see infra/backup (T4) / .github (T7)" >&2
	@exit 1

.PHONY: restore
restore: ## [not implemented] Restore Supabase from a backup - see infra/backup (T4)
	@echo "not implemented yet — see infra/backup (T4) / .github (T7)" >&2
	@exit 1

.PHONY: deploy
deploy: ## [not implemented] Deploy to the VPS - see .github (T7)
	@echo "not implemented yet — see infra/backup (T4) / .github (T7)" >&2
	@exit 1
