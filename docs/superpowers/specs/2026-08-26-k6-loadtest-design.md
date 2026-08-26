# k6 Load Test Scripts — Design

Date: 2026-08-26
Scope: `loadtest/` directory only — no changes to `backend/` or `deploy/`.

## Goal

Implement the scripts described in `loadtest/README.md` and architecture doc §9:
a read scenario, a write scenario, and a repeatable reset step, all runnable
against this project's own stack (`BASE_URL` default `http://localhost`) and,
for read/write, against another group's API by swapping `BASE_URL`.

## Endpoints under test (confirmed from source)

| Endpoint | Auth | Notes |
|---|---|---|
| `POST /api/v1/auth/token` | none | body `{ userId }` → `{ status, accessToken }` |
| `GET /api/v1/products?page=&limit=` | none | no `JwtGuard` on this controller |
| `POST /api/v1/orders` | `Bearer <jwt>` | body `{ productId }` → `202 { status:'processing', orderJobId }` on success, `409 { status:'rejected', message }` on duplicate/soldout (both expected, not failures) |

Seed data: 20 products, `p-1001` has `availableStock: 50`.

## Files

```
loadtest/
├── lib/
│   └── auth.js       # shared: getTokens(baseUrl, count) -> [{ userId, token }]
├── read.js
├── write.js
├── reset.js
└── README.md          # updated with real usage + thresholds
```

### `lib/auth.js`

Exports `getTokens(baseUrl, count)`. Uses `http.batch` to POST
`/api/v1/auth/token` for `user-1`…`user-{count}` concurrently in `setup()`,
returns array of `{ userId, token }`. Only `write.js` needs this — `read.js`
hits an endpoint with no guard.

### `read.js`

- No `setup()` auth needed.
- 1,000 VUs (`ramping-vus` ramp to 1000 over ~30s, hold, ramp down).
- Each iteration: random `page` in 1-3, random `limit` in [10, 20, 50] (occasionally
  garbage values like `page=-5`/`limit=abc` at low probability to exercise the
  clamp-to-default path documented in the architecture doc §4.4).
- Checks: status 200, `meta.totalPages === Math.ceil(meta.total / meta.limit)`,
  `data.length <= limit`.
- Thresholds: `http_req_duration: p(95)<500`, `http_req_failed: rate<0.01`.

### `write.js`

- `setup()`: `getTokens(BASE_URL, 500)`.
- 500 VUs, each mapped to one fixed user via `tokens[(__VU - 1) % 500]` — every
  VU always claims `p-1001` as itself, no cross-user drift between iterations.
- Every 10th VU (`__VU % 10 === 0`) issues 2-3 requests in a single iteration
  using the *same* token, to simulate a double-tap/retry from one real user —
  this is what should get rejected by the `SADD`-based duplicate check.
- Request: `http.request('POST', ..., body, { headers, responseCallback: http.expectedStatuses(202, 409) })`
  so the expected `409` (duplicate/soldout) doesn't count toward
  `http_req_failed`.
- Custom `Counter`s: `orders_accepted`, `orders_duplicate`, `orders_soldout`,
  `orders_unexpected` (anything not 202/409, e.g. 401/500) — parsed from
  response body `status` field, cross-checked against `_metrics` after the run.
- Thresholds: `http_req_duration: p(95)<800` (includes Redis EVAL + BullMQ enqueue),
  custom rate `orders_unexpected` `<0.01`.

### `reset.js`

Plain Node script (no npm deps beyond Node stdlib), run from the host before
every test run:

```
node loadtest/reset.js
```

Internally shells out via `child_process.execFileSync` to:
- `docker compose exec -T postgres psql -U $POSTGRES_USER -d $POSTGRES_DB -c "TRUNCATE orders RESTART IDENTITY; UPDATE products SET remaining_stock = available_stock;"`
- For each product id (read from `backend/data/products-seed.json`):
  `docker compose exec -T redis redis-cli SET cache:stock:{id} {availableStock}`
  and `redis-cli DEL cache:claim:{id}`
- `docker compose exec -T redis redis-cli --scan --pattern "cache:template:*"` piped
  to `DEL`, plus reset of `cache:m:*` metric counters, so each run's cache-hit
  numbers aren't polluted by the previous run.

Reads `POSTGRES_USER`/`POSTGRES_DB` from `deploy/.env` (same file backend
uses) so credentials aren't duplicated. Runs `docker compose` with
`-f deploy/docker-compose.yml` from the repo root, or relies on cwd — script
resolves the compose file path relative to its own location so it works from
anywhere.

No port mapping added to `docker-compose.yml`, no new backend endpoint —
reset is test housekeeping, not simulated user traffic, and doesn't need to
go through nginx.

## Out of scope

- No changes to `docker-compose.yml` or backend source.
- No CI wiring — these are run manually per the architecture doc's test
  procedure.
- `_metrics` and Bull-Board inspection after a run stay manual (`curl`/browser),
  not scripted — the doc already lists the SQL correctness checks and metrics
  endpoint; this spec doesn't duplicate that.

## Open risk

`docker compose exec` requires the stack to already be up when `reset.js`
runs — this is expected (you reset between test runs, not before first boot).
