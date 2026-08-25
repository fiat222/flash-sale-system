# flash-sale-system

Flash sale backend — final assignment (mobile 240-331). Full design rationale, resource
budget, and read/write path details: [`flash-sale-architecture.md`](flash-sale-architecture.md).

## Layout

```
backend/    NestJS + Fastify app (api / worker / migrate roles, one image)
loadtest/   k6 scripts (read + write scenarios)
deploy/     docker-compose.yml, nginx.conf, .env.example
```

## Run

```bash
cp deploy/.env.example deploy/.env   # fill in real secrets
cd deploy
docker compose up --build
```

## Team split

See [`backend/README.md`](backend/README.md) for the A/B/C ownership breakdown.

## Contributing

Branch model, commit convention, branch protection setup: [`CONTRIBUTING.md`](CONTRIBUTING.md).
