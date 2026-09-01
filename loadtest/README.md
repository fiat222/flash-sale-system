# loadtest

k6 scripts. Base URL is configurable so other groups' APIs can be tested with the
same scripts — set `BASE_URL` env var, default `http://localhost`.

```bash
node loadtest/reset.js               # reset DB + Redis state (stack must already be up)
k6 run -e BASE_URL=http://172.30.58.10 loadtest/read.js
k6 run -e BASE_URL=http://172.30.58.10 loadtest/write.js
k6 run -e BASE_URL=http://172.30.58.10 loadtest/flash-sale.js

# with the k6 web dashboard (live during the run) + an HTML export for the report
K6_WEB_DASHBOARD=true K6_WEB_DASHBOARD_EXPORT=loadtest/results/report.html \
  k6 run -e BASE_URL=http://172.30.58.10 loadtest/flash-sale.js

# same, via the grafana/k6 docker image
docker run --rm -v ${PWD}/loadtest:/loadtest -p 5665:5665 \
  -e K6_WEB_DASHBOARD=true -e K6_WEB_DASHBOARD_EXPORT=/loadtest/results/report.html \
  grafana/k6 run -e BASE_URL=http://172.30.58.10 /loadtest/flash-sale.js
```

`flash-sale.js` also writes `loadtest/results/report-table.json` on every run — the 4
report categories (Cache Performance, Queue Monitoring, Throughput & Latency, Data
Integrity) as flat numbers, ready to paste into a spreadsheet/table. The same numbers
print as a `REPORT TABLE` block at the end of the console summary.

Live view of the app-side numbers (cache hit%, worker UP/DOWN, queue depth, order
outcomes, live stock) during a run: `GET /api/v1/_dashboard`.

Run `reset.js` before every `write.js` run (and before `read.js` if you care about
comparable cache-hit numbers across runs).

## Scripts

| File | Scenario |
|---|---|
| `lib/auth.js` | shared helper — `getTokens(baseUrl, count, timeout)` issues JWTs via batched `POST /auth/token`; per-request timeout defaults to `REQ_TIMEOUT` (10s). `write.js` sets `setupTimeout: 30s` around it. |
| `read.js` | 1,000 VU ramping (~50s: 10s ramp / 35s hold / 5s down), `GET /products?page=1&limit=10` (spec). Tunables at top of file, all env-overridable: `TARGET` `RAMP` `HOLD` `RAMPDOWN` `REQ_TIMEOUT` (10s). `-e MIX=1` → random page/limit + 5% garbage input. `teardown()` prints the Redis cache hit/miss ratio from `/api/v1/_metrics`. |
| `write.js` | 500 VU, one fixed user each, `POST /orders` on `p-1001`; every 10th VU fires 2-3 **concurrent** identical requests (`http.batch`) to race the SADD lock. Single burst — finishes in seconds. Tunables at top: `USER_COUNT` `MAX_DURATION` (50s) `REQ_TIMEOUT` (10s). `teardown()` prints order counters + manual-check reminders. |
| `reset.js` | plain Node script — `docker compose exec` into `postgres`/`redis` to truncate orders, restore stock, clear claims/template/metrics cache |

`read.js` doesn't authenticate — `GET /products` has no `JwtGuard`. `write.js` gets
its 500 tokens from `lib/auth.js` in `setup()`.

## Thresholds

| Script | Threshold |
|---|---|
| `read.js` | `http_req_duration p(95)<500ms`, `http_req_failed rate<1%` |
| `write.js` | `http_req_duration p(95)<800ms`, `orders_unexpected rate<1%` (409 duplicate/soldout is expected, not a failure) |

## Metrics to capture (for the report)

| item | source | scripted? |
|---|---|---|
| cache hit/miss ratio (Redis Cache-Aside, no in-process cache) | `GET /api/v1/_metrics` → `cache_hit` / `cache_miss` | ✓ `flash-sale.js`/`read.js` `teardown()` prints it, in `report-table.json` |
| worker status (UP/DOWN) | `GET /api/v1/_metrics` → `workerStatus` (worker writes a 2s heartbeat, 5s TTL) | ✓ printed + dashboarded |
| jobs waiting/active/delayed, completed/failed (lifetime) | `GET /api/v1/_metrics` → `queue`, `metrics.orders_completed/failed` | ✓ printed + dashboarded |
| Bull-Board window (last N jobs only) | `http://<host>/admin/queues` (nginx-proxied — no direct :3001 access) | manual, cross-check only |
| req/s, p95, error rate | k6 summary output / `report-table.json` | ✓ |
| data integrity (remainingStock, no duplicate/over-fulfilled orders) | `GET /api/v1/products` (scripted) + DB screenshot (manual) | partial — see below |

Note: Bull-Board "Completed" reads 0 while `orders.service.ts` keeps `removeOnComplete: true`
— use the lifetime `orders_completed`/`orders_failed` counters instead, they don't decay.

## Correctness check after each run

`remainingStock == 0` is checked automatically by `flash-sale.js` (`data_integrity_ok`
threshold). The "no duplicate / no over-fulfilled order" half still needs a DB screenshot
for the report — one query proves all three numbers at once:

```sql
SELECT remaining_stock FROM products WHERE product_id = 'p-1001';   -- expect 0, never negative

SELECT COUNT(*)               AS total_orders,
       COUNT(DISTINCT user_id) AS distinct_users,
       MAX(cnt)                AS max_orders_per_user
FROM (SELECT user_id, COUNT(*) AS cnt FROM orders WHERE product_id = 'p-1001' GROUP BY user_id) x;
-- expect total_orders == distinct_users == 50 AND max_orders_per_user == 1
```

## Reset

`node loadtest/reset.js` requires the stack (`docker compose up`) to already be running —
it execs `psql`/`redis-cli` inside the `postgres`/`redis` containers, no DB ports need to
be exposed to the host and no test-only endpoint exists in the backend.
