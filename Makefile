.PHONY: dev down check test ci build db-migrate logs hooks check-browser-contract check-browser-contract-cross-repo

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

# 与 GitHub Actions CI 同路径的本地流水线：
# 重建 web 镜像（package.json/worker/vite.config 不在卷挂载内，镜像烘焙会陈旧）→
# 迁移 → lint → 单元/契约 → 集成 → 构建 + 渲染 + HTTP 层 → markdown 链接检查。
ci:
	docker compose build web
	docker compose run --rm migrate
	docker compose run --rm web npm run lint
	docker compose run --rm web npm run test:unit
	docker compose run --rm web npm run test:integration
	docker compose run --rm web sh -c "npm run build && node --test tests/rendered-html.test.mjs tests/http-read.integration.test.mjs"
	node scripts/check-md-links.mjs

build:
	docker compose build web

db-migrate:
	docker compose run --rm migrate

logs:
	docker compose logs -f web db

check-browser-contract:
	node scripts/check-browser-contracts.mjs
	cd apps/web && node --test tests/browser-collection-contract.test.mjs tests/browser-contract-schema-check.test.mjs

check-browser-contract-cross-repo: check-browser-contract
	@test -n "$(CSDN_AGENT_REPO)" || (echo "CSDN_AGENT_REPO is required" && exit 1)
	node scripts/check-browser-contracts.mjs --provider-repo "$(CSDN_AGENT_REPO)"
