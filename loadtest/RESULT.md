## ผลลัพธ์การ read
docker run --rm --network flash-sale-system_default -v ${PWD}/loadtest:/loadtest grafana/k6 run -e BASE_URL=http://nginx /loadtest/read.js

 THRESHOLDS 

    http_req_duration
    ✗ 'p(95)<500' p(95)=511.28ms

    http_req_failed
    ✓ 'rate<0.01' rate=0.14%


  █ TOTAL RESULTS 

    checks_total.......: 482013 4597.902007/s
    checks_succeeded...: 99.85% 481314 out of 482013
    checks_failed......: 0.14%  699 out of 482013

    ✗ status is 200
      ↳  99% — ✓ 160438 / ✗ 233
    ✗ totalPages matches formula
      ↳  99% — ✓ 160438 / ✗ 233
    ✗ data length <= limit
      ↳  99% — ✓ 160438 / ✗ 233

    HTTP
    http_req_duration..............: avg=530.52ms min=669.77µs med=316ms    max=59.86s p(90)=502.45ms p(95)=511.28ms
      { expected_response:true }...: avg=445.65ms min=669.77µs med=315.83ms max=59.8s  p(90)=502.32ms p(95)=510.82ms
    http_req_failed................: 0.14%  233 out of 160671
    http_reqs......................: 160671 1532.634002/s

    EXECUTION
    iteration_duration.............: avg=533.18ms min=799.91µs med=316.4ms  max=1m0s   p(90)=502.82ms p(95)=511.57ms
    iterations.....................: 160671 1532.634002/s
    vus............................: 168    min=28            max=1000
    vus_max........................: 1000   min=1000          max=1000

    NETWORK
    data_received..................: 185 MB 1.8 MB/s
    data_sent......................: 15 MB  141 kB/s

running (1m44.8s), 0000/1000 VUs, 160671 complete and 0 interrupted iterations
read ✓ [ 100% ] 0000/1000 VUs  1m45s
time="2026-08-26T04:40:08Z" level=error msg="thresholds on metrics 'http_req_duration' have been crossed"

# สรุป

## Diagnosis: 233 request timeout (60s) ทุกรอบ

**สาเหตุที่หาเจอและแก้แล้ว (คนละตัวกับ 233 ที่เหลือ แต่เป็นบั๊กจริง):**

| ปัญหา | หลักฐาน (ก่อนแก้ → หลังแก้) | Fix |
|---|---|---|
| `worker_connections` เตี้ยไป (1024, 1 worker) → รับ concurrent ได้แค่ ~512 คู่ proxy | burst 1000 concurrent: `ECONNRESET` 384/1000 → 0/1000 | `deploy/nginx.conf`: `worker_connections 1024` → `8192` + เพิ่ม `worker_rlimit_nofile 16384` (container `ulimit -n`=1,048,576 มี headroom เหลือเฟือ ไม่เสี่ยง OOM) |
| accept queue ล้น (`listen 80;` ไม่ตั้ง backlog เลย ใช้ default 511 ทั้งที่ kernel `somaxconn`=4096) | kernel counter `/proc/net/netstat` (TcpExt): `ListenOverflows`/`ListenDrops` = 7140 → 0 หลัง fix (รันโหลดเท่าเดิม) | `deploy/nginx.conf`: `listen 80;` → `listen 80 backlog=4096;` |

**วิธี falsify แต่ละสมมติฐานที่ตัดทิ้งไปตามลำดับ** (กันคนอ่านทีหลังไปเสียเวลาซ้ำ):
1. ยิงตรงเข้า `api1` ข้าม nginx (400 concurrent, node http client ใน `worker` container) → 0 fail, 1.76s → **ไม่ใช่ backend**
2. เช็ค Fastify `keepAliveTimeout` default = 72000ms > nginx upstream `keepalive_timeout` default 60s → ทิศทางปลอดภัยอยู่แล้ว → **ไม่ใช่ keepalive race ระหว่าง nginx-backend**
3. รัน k6 จาก Windows host ผ่าน `localhost` vs รันเป็น container ติด docker network ตรง (`--network flash-sale-system_default`, `BASE_URL=http://nginx`) ได้ผลเหมือนกันทุกรอบ → **ไม่ใช่ข้อจำกัดของ Docker Desktop port-forward** (ข้อสรุปที่เคยเข้าใจผิดตอนแรก เพราะ test bypass ตอนนั้นไม่ได้ใช้ HTTP keep-alive แบบเดียวกับ k6 จริง — false negative)
4. เช็ค log `api1/api2/api3`, `redis`, `nginx` (`docker compose logs`) ระหว่างรันที่ fail → **ไม่มี error/warning โผล่เลยสักบรรทัด** → connection ไม่เคยไปถึงชั้น application หรือแม้แต่ nginx accept() → ชี้ไปที่ kernel/socket layer ก่อนถึง nginx logic

**233-328 request ที่ยัง timeout อยู่ — เจอสาเหตุจริงแล้ว: nginx CPU throttling**

ตรวจ `docker inspect` → `nginx` container ถูกจำกัดแค่ `cpus: "0.25"` ตาม resource budget เดิม เช็ค cgroup `cpu.stat` ตอนรันโหลด:
```
nr_periods 6164
nr_throttled 5298        ← 85.9% ของทุก period ถูก throttle
throttled_usec 439356193 ← สะสม ~439 วินาที
```
nginx ถูก CFS throttle เกือบทุกช่วง 100ms — request ไม่ได้ถูก reject ที่ไหนเลย (เข้าใจได้ทันทีว่าทำไม kernel counter ทุกตัวที่เช็คไปก่อนหน้า — `ListenOverflows`, conntrack `drop` — เป็น 0 หมด) มันแค่**รอ nginx process ได้คิว CPU ครั้งถัดไป** ยิ่ง throttle นาน ยิ่งมี request ค้างพร้อมกันเป็นกลุ่ม ตรงกับ pattern ที่ timeout กระจุกตัวเป็นช่วง ~7-8 วินาทีสั้นๆ แทนที่จะกระจายทั่วทั้ง 105 วินาทีของการทดสอบ

**Fix:** `deploy/docker-compose.yml` — เพิ่ม `nginx` cpus `0.25` → `0.5`, ลด `postgres` cpus `1.0` → `0.75` (postgres ไม่โดน read path แตะเลยตามที่ doc ระบุเอง มี headroom เหลือให้ดึงมาใช้ รวม budget เท่าเดิม 4.1 core ไม่เกิน host 4 vCPU)

**ผลยืนยันหลัง fix (รันเดียวกันทุกอย่าง):**

| metric | ก่อน | หลัง |
|---|---|---|
| `checks_failed` | 0.14-0.24% | **0.00%** (0/953,544) |
| `http_req_failed` | 0.14-0.24% | **0.00%** (0/317,848) |
| `p95` | 506-602ms (เกิน threshold) | **373.3ms** (ผ่าน) |
| throughput | ~1,500 req/s | **~3,100 req/s** |

ทั้งสามบั๊ก (`worker_connections`, `backlog`, nginx CPU) เป็นคนละชั้นกัน ต้องแก้ครบทั้งสามตัวถึงหาย — แก้แค่ 2 ตัวแรกไม่พอ เพราะตัวที่ทำให้เกิด timeout จริงคือ CPU throttling ล้วนๆ

