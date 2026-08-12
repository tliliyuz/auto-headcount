.PHONY: dev down check test build db-migrate logs hooks

hooks:
	git config core.hooksPath .githooks
	chmod +x .githooks/pre-commit .githooks/commit-msg
	@echo "已启用 .githooks 钩子（pre-commit + commit-msg）；SKIP_GIT_HOOKS=1 可临时放行"

dev:
	docker compose up --build

down:
	docker compose down

check:
	docker compose run --rm web npm run lint

test:
	docker compose run --rm web npm test
	docker compose run --rm web npm run test:integration

build:
	docker compose build web

db-migrate:
	docker compose run --rm migrate

logs:
	docker compose logs -f web db
