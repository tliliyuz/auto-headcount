.PHONY: dev down check test build db-migrate logs

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
