# flash-sale-system GROUP 02

Flash sale backend — final assignment (mobile 240-331). Full design rationale, resource
budget, and read/write path details: [`flash-sale-architecture.md`](flash-sale-architecture.md).

## IP: 172.38.50.10
## Port Open ONLY 80

## DASHBOARD Avaible
# cache ratio
http://172.30.58.10/api/v1/_dashboard
# bullMQ
http://172.30.58.10/admin/queues/queue/orders

# RESET Cache and Orders
in vm /home/project/
``` bash
node reset.js
```

## Layout

```
backend/    NestJS + Fastify app (api / worker / migrate roles, one image)
loadtest/   k6 scripts (read / write / flash-sale scenarios + report table)
deploy/     docker-compose.yml, nginx.conf, .env.example
```

## Run For Develop

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up --build
```

## Run

```bash
cp deploy/.env.example deploy/.env   # fill in real secrets
cd deploy
docker compose up --build
```


## Load test

See [`loadtest/README.md`](loadtest/README.md). Quick run:

```bash
node loadtest/reset.js
k6 run -e BASE_URL=http://localhost loadtest/flash-sale.js
```
```bash
K6_WEB_DASHBOARD=true K6_WEB_DASHBOARD_EXPORT=loadtest/results/report.html \
  k6 run -e BASE_URL=http://172.30.58.10 loadtest/flash-sale.js
```

Prints cache hit%, worker status, queue depth, req/s and data-integrity checks as a
`REPORT TABLE` in console output (also written to `loadtest/results/report-table.json`).
Live dashboard during a run: `GET /api/v1/_dashboard`.

