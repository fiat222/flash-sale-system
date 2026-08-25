# backend

NestJS + Fastify app. Full design rationale: [`../flash-sale-architecture.md`](../flash-sale-architecture.md).

## Ownership (3-person split)

| Owner | Scope |
|---|---|
| A — Infra | `deploy/`, `Dockerfile`, migrations + seed, health checks, pool sizing |
| B — Read path | products module, template cache, L1 cache, pagination, `/metrics` |
| C — Write path | auth + JWT guard, orders, Lua script, BullMQ worker, compensation, Bull-Board |

## Local dev

Either run directly on the host against local Postgres/Redis:

```bash
npm install
npm run start:dev
```

Or run the whole stack in Docker with hot reload (no rebuild needed per edit):

```bash
cd ../deploy
docker compose -f docker-compose.yml -f docker-compose.dev.yml up --build
```

Edits under `backend/src` recompile and restart automatically. This uses
polling-based file watching (`tsconfig.json`'s `watchOptions`) because Docker
Desktop on Windows/Mac doesn't forward host filesystem events into the
container's inotify across a bind mount — native watching silently never
fires without it.

## Roles

Same image, three run modes selected by `$ROLE` env var (set in `deploy/docker-compose.yml`):

- `ROLE=api` — HTTP server, enqueues jobs, never blocks on worker logic
- `ROLE=worker` — BullMQ processor, holds Postgres pessimistic locks
- `ROLE=migrate` — one-shot: run migrations + seed, then exit
