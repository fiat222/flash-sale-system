# backend

NestJS + Fastify app. Full design rationale: [`../flash-sale-architecture.md`](../flash-sale-architecture.md).

## Ownership (3-person split)

| Owner | Scope |
|---|---|
| A — Infra | `deploy/`, `Dockerfile`, migrations + seed, health checks, pool sizing |
| B — Read path | products module, template cache, L1 cache, pagination, `/metrics` |
| C — Write path | auth + JWT guard, orders, Lua script, BullMQ worker, compensation, Bull-Board |

## Local dev

```bash
npm install
npm run start:dev
```

## Roles

Same image, three run modes selected by `$ROLE` env var (set in `deploy/docker-compose.yml`):

- `ROLE=api` — HTTP server, enqueues jobs, never blocks on worker logic
- `ROLE=worker` — BullMQ processor, holds Postgres pessimistic locks
- `ROLE=migrate` — one-shot: run migrations + seed, then exit
