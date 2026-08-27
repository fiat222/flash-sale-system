# loadtest

k6 scripts. Base URL is configurable so other groups' APIs can be tested with the
same scripts — set `BASE_URL` env var, default `http://localhost`.

`flash-sale.js` is the single-file run that follows the assignment's queue order
(setup auth → timed read → timed write). `read.js` / `write.js` are the older
split scripts, kept for isolating one phase.

```bash
node loadtest/reset.js                                    # reset DB + Redis + BullMQ queue (stack must be up)
k6 run -e BASE_URL=http://localhost loadtest/flash-sale.js
```

Always run `reset.js` immediately before `flash-sale.js` / `write.js` — it also
flushes `bull:orders:*`, without which retained job IDs dedup the next run's
orders (Redis stock decrements but no DB row is written).

## Live visualization + HTML report (k6 web dashboard)

k6 has a built-in dashboard — no Grafana/InfluxDB, no extra containers, and zero
load on the system under test (the dashboard is served from the k6 process).

```bash
docker run --rm --network flash-sale-system_default -v "$PWD/loadtest:/loadtest" -w / -p 5665:5665 -e BASE_URL=http://nginx -e K6_WEB_DASHBOARD=true -e K6_WEB_DASHBOARD_EXPORT=/loadtest/results/report.html -e K6_WEB_DASHBOARD_PERIOD=2s grafana/k6 run /loadtest/flash-sale.js
```

- **during the run:** open <http://localhost:5665> — live req/s, p95/p99, VUs,
  error rate, per-scenario panels.
- **after the run:** `loadtest/results/report.html` is a self-contained file
  (open in any browser, drop into the report PDF).

Local k6 (not Docker): `K6_WEB_DASHBOARD=true K6_WEB_DASHBOARD_EXPORT=loadtest/results/report.html k6 run loadtest/flash-sale.js`

Run the dashboard on the tester's machine, not on the 4-core VM — point
`BASE_URL` at the VM instead.

## flash-sale.js phases

| # | phase | timed? | what |
|---|---|---|---|
| 1 | `setup()` | no | issue 500 JWTs (`user-1..user-500`); aborts the run if any `!= 200` |
| 2 | `read_load` | yes | 1,000 VU ramping, `GET /products?page=1&limit=10` |
| 3 | `write_load` | yes | 500 VU, `POST /orders` for `p-1001`; every 10th VU double/triple-fires concurrently |

`teardown()` pulls `GET /api/v1/_metrics` for the **cache check** (`cache_hit` /
`cache_miss` ratio) and **queue check** (`waiting`/`active` + lifetime
`orders_completed` / `orders_failed`). `handleSummary()` prints threshold
PASS/FAIL + per-phase p95/req-s and writes `loadtest/results/flash-sale-summary.json`.
All knobs are env-overridable constants at the top of the file.

## Scripts

| File | Scenario |
|---|---|
| `lib/auth.js` | shared helper — `getTokens(baseUrl, count, timeout)` issues JWTs via batched `POST /auth/token`; per-request timeout defaults to `REQ_TIMEOUT` (10s). `write.js` sets `setupTimeout: 30s` around it. |
| `read.js` | 1,000 VU ramping (~50s: 10s ramp / 35s hold / 5s down), `GET /products?page=1&limit=10` (spec). Tunables at top of file, all env-overridable: `TARGET` `RAMP` `HOLD` `RAMPDOWN` `REQ_TIMEOUT` (10s). `-e MIX=1` → random page/limit + 5% garbage input. `teardown()` prints the Redis cache hit/miss ratio from `/api/v1/_metrics`. |
| `write.js` | 500 VU, one fixed user each, `POST /orders` on `p-1001`; every 10th VU fires 2-3 **concurrent** identical requests (`http.batch`) to race the SADD lock. Single burst — finishes in seconds. Tunables at top: `USER_COUNT` `MAX_DURATION` (50s) `REQ_TIMEOUT` (10s). `teardown()` prints order counters + manual-check reminders. |
| `flash-sale.js` | single-file, spec queue order (setup → read → write) with the k6 web dashboard, cache/queue teardown checks, and a JSON+banner summary. See phases table below. |
| `reset.js` | plain Node script — `docker compose exec` into `postgres`/`redis` to truncate orders, restore stock, clear claims/template/metrics cache, **and flush `bull:orders:*`** |

`read.js` doesn't authenticate — `GET /products` has no `JwtGuard`. `write.js` gets
its 500 tokens from `lib/auth.js` in `setup()`.

## Thresholds

| Script | Threshold |
|---|---|
| `flash-sale.js` | `http_req_duration{scenario:read_load} p(95)<500ms`, `http_req_duration{scenario:write_load} p(95)<800ms`, `infra_failures rate<1%` (5xx / timeout / non-409 4xx — 409 duplicate/soldout is expected), `checks{...} rate>0.99` per scenario |
| `read.js` | `http_req_duration p(95)<500ms`, `http_req_failed rate<1%` |
| `write.js` | `http_req_duration p(95)<800ms`, `orders_unexpected rate<1%` (409 duplicate/soldout is expected, not a failure) |

## Metrics to capture (for the report)

| item | source | scripted? |
|---|---|---|
| cache hit/miss ratio (Redis Cache-Aside, no in-process cache) | `GET /api/v1/_metrics` → `cache_hit` / `cache_miss` | ✓ `read.js` `teardown()` prints it |
| order counters (accepted/duplicate/soldout) | `GET /api/v1/_metrics` | ✓ `write.js` `teardown()` prints it |
| queue completed / failed / waiting, worker status | Bull-Board `http://localhost:3001/admin/queues` (worker container, not behind nginx); also in `flash-sale.js` `teardown()` | ✓ / manual screenshot |
| req/s, p95, error rate over time | k6 web dashboard → `report.html` | ✓ |

`orders.service.ts` uses `removeOnComplete: { count: 1000 }`, so Bull-Board's
Completed tab shows the last 1,000 finished jobs (50 after one `flash-sale.js`
run). `reset.js` flushes them.

## Data Integrity Proof (capture the database)

Postgres is not exposed outside the VM by design, so this is a direct psql
snapshot — run it on the VM (or over SSH) after a `flash-sale.js` run and
screenshot the output:

```bash
docker compose -f deploy/docker-compose.yml exec postgres \
  psql -U flash_sale -d flash_sale -c "
    SELECT remaining_stock FROM products WHERE product_id = 'p-1001';          -- expect 0, never < 0
    SELECT COUNT(*)          AS orders,
           COUNT(DISTINCT user_id) AS distinct_buyers,
           COALESCE(MAX(c),0) AS max_per_user
      FROM (SELECT COUNT(*) c FROM orders WHERE product_id='p-1001' GROUP BY user_id) t;  -- expect 50 / 50 / 1
    SELECT user_id, created_at FROM orders WHERE product_id='p-1001' ORDER BY created_at;  -- 50 distinct rows
  "
```

`products` also has a `CHECK (remaining_stock >= 0)` constraint — a negative
value is impossible at the DB level, not just unlikely.

## Reset

`node loadtest/reset.js` requires the stack (`docker compose up`) to already be running —
it execs `psql`/`redis-cli` inside the `postgres`/`redis` containers, no DB ports need to
be exposed to the host and no test-only endpoint exists in the backend.
