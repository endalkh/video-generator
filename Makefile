# Kids Animation Studio — common tasks. Run `make help` for the list.

COMPOSE := docker compose

.DEFAULT_GOAL := help
.PHONY: help install dev start build serve typecheck test check css css-watch \
        db-up db-migrate db-migrate-dev db-generate db-studio \
        up down restart logs ps rebuild clean

help: ## Show available targets
	@awk 'BEGIN {FS = ":.*## "} /^[a-zA-Z_-]+:.*## / {printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}' $(MAKEFILE_LIST)

# ---- Local development ----
install: ## Install npm dependencies (runs prisma generate)
	npm ci

dev: ## Run app locally with watch mode
	npm run dev

start: ## Run app locally (no watch)
	npm start

build: ## Compile TypeScript and CSS into dist/
	npm run build

serve: build ## Build and run the compiled app
	npm run serve

typecheck: ## Type-check app and tests
	npm run typecheck

test: ## Run unit tests
	npm test

check: typecheck test ## Typecheck + tests

css: ## Build Tailwind CSS
	npm run ui:css

css-watch: ## Watch and rebuild Tailwind CSS
	npm run ui:css:watch

# ---- Database ----
db-up: ## Start only Postgres (for local dev)
	$(COMPOSE) up -d postgres

db-migrate: ## Apply pending migrations
	npm run db:migrate

db-migrate-dev: ## Create/apply a dev migration
	npm run db:migrate:dev

db-generate: ## Generate Prisma client
	npm run db:generate

db-studio: ## Open Prisma Studio
	npm run db:studio

# ---- Docker ----
up: ## Build and start app + Postgres + pgAdmin
	$(COMPOSE) up -d --build

down: ## Stop all containers
	$(COMPOSE) down

restart: ## Restart the app container
	$(COMPOSE) restart app

rebuild: ## Rebuild the app image without cache and restart
	$(COMPOSE) build --no-cache app
	$(COMPOSE) up -d app

logs: ## Follow app logs
	$(COMPOSE) logs -f app

ps: ## Show container status
	$(COMPOSE) ps

clean: ## Remove build output (keeps node_modules and generated media)
	rm -rf dist public/app.css
