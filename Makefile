# Heimdall developer commands. `make help` lists them.
SHELL := /bin/bash
COMPOSE ?= docker compose
PROD := docker compose -f docker-compose.prod.yml
# .env is read by docker compose and the scripts themselves, not included here:
# make would mangle any `$` in a password.
port = $$(grep -E '^$(1)=' .env 2>/dev/null | cut -d= -f2 | grep . || echo $(2))

.DEFAULT_GOAL := help

## ---------- stack ----------

.PHONY: help
help: ## Show this help
	@grep -hE '^(## |[a-zA-Z0-9_-]+:.*## )' $(MAKEFILE_LIST) | \
	  awk 'BEGIN {FS = ":.*## "}; /^## / {printf "\n\033[1m%s\033[0m\n", substr($$0, 4); next} {printf "  \033[36m%-15s\033[0m %s\n", $$1, $$2}'

.env:
	@cp .env.example .env
	@sed -i "s|^JWT_SECRET=$$|JWT_SECRET=$$(python3 -c 'import secrets; print(secrets.token_urlsafe(48))')|" .env
	@sed -i "s|^ENCRYPTION_KEY=$$|ENCRYPTION_KEY=$$(python3 -c 'import base64,os; print(base64.urlsafe_b64encode(os.urandom(32)).decode())')|" .env
	@sed -i "s|^WORKER_SHARED_SECRET=$$|WORKER_SHARED_SECRET=$$(python3 -c 'import secrets; print(secrets.token_urlsafe(32))')|" .env
	@echo "Created .env with fresh secrets."

.PHONY: env
env: .env ## Create .env from .env.example with generated secrets

.PHONY: up
up: .env ## Build and start the whole stack
	$(COMPOSE) up --build -d
	@echo ""
	@echo "  Frontend   http://localhost:$(call port,FRONTEND_PORT,8080)"
	@echo "  API docs   http://localhost:$(call port,API_PORT,8000)/docs"
	@echo "  RabbitMQ   http://localhost:$(call port,RABBITMQ_MANAGEMENT_PORT,15672)"
	@echo "  Receiver   http://localhost:$(call port,MOCK_RECEIVER_PORT,9000)/requests  (endpoint URL: http://mock-receiver:9000/hooks/ok)"

.PHONY: down
down: ## Stop the stack (keeps data)
	$(COMPOSE) down

.PHONY: restart
restart: ## Restart all services
	$(COMPOSE) restart

.PHONY: logs
logs: ## Follow logs (make logs s=worker for one service)
	$(COMPOSE) logs -f $(s)

.PHONY: ps
ps: ## Show service status
	$(COMPOSE) ps

.PHONY: build
build: ## Build the images
	$(COMPOSE) build

.PHONY: migrate
migrate: ## Apply database migrations
	$(COMPOSE) exec api alembic upgrade head

.PHONY: shell
shell: ## Open a shell in the api container
	$(COMPOSE) exec api bash

.PHONY: clean
clean: ## Stop the stack and DELETE its volumes (database, broker, payloads)
	@read -p "Delete all local Heimdall data? [y/N] " ok && [[ $$ok == [yY] ]]
	$(COMPOSE) down -v --remove-orphans

## ---------- checks ----------

.PHONY: test-services
test-services:
	@$(COMPOSE) exec -T postgres sh -c "psql -U heimdall -tAc \"SELECT 1 FROM pg_database WHERE datname='heimdall_test'\" | grep -q 1 || createdb -U heimdall heimdall_test"
	@$(COMPOSE) exec -T rabbitmq sh -c 'rabbitmqctl -q add_vhost heimdall_test >/dev/null 2>&1; rabbitmqctl -q set_permissions -p heimdall_test "$$RABBITMQ_DEFAULT_USER" ".*" ".*" ".*"'

.PHONY: test
test: test-services ## Backend tests (unit + integration) inside the api container
	$(COMPOSE) exec -T -e CI_REQUIRE_SERVICES=1 api pytest --cov --cov-report=term-missing:skip-covered $(args)

.PHONY: test-frontend
test-frontend: ## Frontend unit/component tests (Vitest)
	cd frontend && npm run test

.PHONY: e2e
e2e: ## Frontend end-to-end tests (Playwright, against the mock API)
	cd frontend && npm run test:e2e

.PHONY: smoke
smoke: ## End-to-end check of the running stack (ingest -> deliver)
	./infrastructure/scripts/smoke-test.sh

.PHONY: lint
lint: ## Lint and type-check backend (in container) and frontend
	$(COMPOSE) exec -T api ruff check .
	$(COMPOSE) exec -T api ruff format --check .
	$(COMPOSE) exec -T api alembic check
	cd frontend && npm run lint && npm run typecheck

.PHONY: fmt
fmt: ## Auto-format the backend
	cd backend && uv run ruff format . && uv run ruff check --fix .

.PHONY: check
check: lint test test-frontend smoke ## Everything CI checks, against the running stack

## ---------- production ----------

.PHONY: prod-up
prod-up: ## Start the production stack (needs Neon/S3 settings in .env)
	$(PROD) up --build -d

.PHONY: prod-down
prod-down: ## Stop the production stack
	$(PROD) down

.PHONY: prod-logs
prod-logs: ## Follow production logs
	$(PROD) logs -f $(s)
