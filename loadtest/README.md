# loadtest

k6 scripts. Base URL is configurable so other groups' APIs can be tested with the
same scripts — set `BASE_URL` env var, default `http://localhost`.

```bash
k6 run -e BASE_URL=http://localhost read.js
k6 run -e BASE_URL=http://localhost write.js
```

## Scripts (planned)

| File | Scenario |
|---|---|
| `auth.js` | `setup()` helper — issues 500 JWTs (`user-1`…`user-500`) |
| `read.js` | 1,000 VU hitting `GET /products?page=&limit=`, varying page/limit |
| `write.js` | 500 VU racing `POST /orders` on `p-1001`, some VUs firing 2-3x |

## Metrics to capture

cache hit/miss ratio (L1/L2), queue completed/failed/waiting, req/s, p95, error rate.

## Correctness check after each run

```sql
SELECT remaining_stock FROM products WHERE product_id = 'p-1001';        -- expect 0
SELECT COUNT(*), COUNT(DISTINCT user_id) FROM orders WHERE product_id = 'p-1001';  -- expect 50 / 50
```

Reset DB + Redis stock/claim state before every run.
