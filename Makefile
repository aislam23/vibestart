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
secrets: ## Generate infra/supabase/.env (refuses to overwrite an existing file)
	bun run secrets:generate

.PHONY: supabase-up
supabase-up: ## Start the Supabase stack
	cd $(SUPABASE_DIR) && docker compose up -d

.PHONY: supabase-down
supabase-down: ## Stop the Supabase stack (keeps volumes - never -v here)
	cd $(SUPABASE_DIR) && docker compose down

.PHONY: supabase-logs
supabase-logs: ## Tail logs for the Supabase stack
	cd $(SUPABASE_DIR) && docker compose logs -f

.PHONY: edge-up
edge-up: ## Start the Caddy edge stack
	cd $(EDGE_DIR) && docker compose up -d

.PHONY: edge-down
edge-down: ## Stop the Caddy edge stack (keeps volumes - never -v here)
	cd $(EDGE_DIR) && docker compose down

.PHONY: up
up: supabase-up edge-up ## Start both stacks (supabase, then edge)

.PHONY: down
down: edge-down supabase-down ## Stop both stacks (edge, then supabase - reverse of up)

.PHONY: status
status: ## Show container status for both stacks + docker volume disk usage
	@echo "== supabase =="
	@cd $(SUPABASE_DIR) && docker compose ps 2>/dev/null || echo "  (not running / no .env yet)"
	@echo "== edge =="
	@cd $(EDGE_DIR) && docker compose ps 2>/dev/null || echo "  (not running / no .env yet)"
	@echo "== docker volumes disk usage =="
	@docker system df | grep -E '^TYPE|^Local Volumes' || docker system df

.PHONY: test
test: ## Run the test suite (bun run test)
	bun run test

.PHONY: typecheck
typecheck: ## Run typechecking across workspaces (bun run typecheck)
	bun run typecheck

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
