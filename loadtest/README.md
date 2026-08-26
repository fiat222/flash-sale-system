# loadtest

k6 scripts. Base URL is configurable so other groups' APIs can be tested with the
same scripts — set `BASE_URL` env var, default `http://localhost`.

```bash
node loadtest/reset.js               # reset DB + Redis state (stack must already be up)
k6 run -e BASE_URL=http://localhost loadtest/read.js
k6 run -e BASE_URL=http://localhost loadtest/write.js
```

Run `reset.js` before every `write.js` run (and before `read.js` if you care about
comparable cache-hit numbers across runs).

## Scripts

| File | Scenario |
|---|---|
| `lib/auth.js` | shared helper — `getTokens(baseUrl, count)` issues JWTs via batched `POST /auth/token` |
| `read.js` | 1,000 VU ramping, `GET /products?page=&limit=`, random page/limit + 5% garbage input |
| `write.js` | 500 VU, one fixed user each, `POST /orders` on `p-1001`; every 10th VU fires 2-3x with the same token |
| `reset.js` | plain Node script — `docker compose exec` into `postgres`/`redis` to truncate orders, restore stock, clear claims/template/metrics cache |

`read.js` doesn't authenticate — `GET /products` has no `JwtGuard`. `write.js` gets
its 500 tokens from `lib/auth.js` in `setup()`.

## Thresholds

| Script | Threshold |
|---|---|
| `read.js` | `http_req_duration p(95)<500ms`, `http_req_failed rate<1%` |
| `write.js` | `http_req_duration p(95)<800ms`, `orders_unexpected rate<1%` (409 duplicate/soldout is expected, not a failure) |

## Metrics to capture (for the report)

cache hit/miss ratio (L1/L2), queue completed/failed/waiting, req/s, p95, error rate —
read from `GET /api/v1/_metrics` and Bull-Board after each run (not scripted; check manually).

## Correctness check after each run

```sql
SELECT remaining_stock FROM products WHERE product_id = 'p-1001';        -- expect 0
SELECT COUNT(*), COUNT(DISTINCT user_id) FROM orders WHERE product_id = 'p-1001';  -- expect 50 / 50
```

## Reset

`node loadtest/reset.js` requires the stack (`docker compose up`) to already be running —
it execs `psql`/`redis-cli` inside the `postgres`/`redis` containers, no DB ports need to
be exposed to the host and no test-only endpoint exists in the backend.
