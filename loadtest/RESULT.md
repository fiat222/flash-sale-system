## ผลลัพธ์การ read
docker run --rm --network flash-sale-system_default -v ${PWD}/loadtest:/loadtest grafana/k6 run -e BASE_URL=http://nginx /loadtest/read.js

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

---

## ผลลัพธ์การ write

```
node loadtest/reset.js
docker run --rm --network flash-sale-system_default -v ${PWD}/loadtest:/loadtest grafana/k6 run -e BASE_URL=http://nginx /loadtest/write.js
```

# สรุป

ผ่านทั้งสอง threshold รอบเดียว ไม่ต้องแก้อะไร

## Correctness (หลัง queue drain)

| เช็ค | คาดหวัง | ได้จริง |
|---|---|---|
| `SELECT remaining_stock FROM products WHERE product_id='p-1001'` | 0 | **0** |
| `SELECT COUNT(*), COUNT(DISTINCT user_id) FROM orders WHERE product_id='p-1001'` | 50 / 50 | **50 / 50** |
| Redis `GET cache:stock:p-1001` | 0 | **0** |
| Redis `SCARD cache:claim:p-1001` | 50 | **50** |
| Bull `ZCARD bull:orders:failed` | 0 | **0** |
| `GET /api/v1/_metrics` | ตรงกับ k6 counter | **`{accepted:50, soldout:521, duplicate:5}`** ตรงเป๊ะ |

**ไม่มี oversell, ไม่มี double-insert** — 50 order / 50 user ไม่ซ้ำ

## หมายเหตุ

- `orders_duplicate` = 5 (ไม่ใช่ ~50) เพราะ Redis stock ถึง 0 เร็วมาก กว่าที่ VU `%10==0` จะยิงรอบสอง stock หมดแล้ว → ได้ 409 soldout แทน duplicate เกือบทั้งหมด สิ่งที่พิสูจน์คือ SADD dedup กันไม่ให้ token เดิมถูก accept ซ้ำ ซึ่งได้ผล (accepted = 50 ตรงกับ stock พอดี ไม่เกิน)
- p95 = 455ms เทียบ read path (373ms) สูงกว่าเพราะ write ผ่าน Lua claim + `queue.add` (Redis round trip เพิ่ม) แต่ยังต่ำกว่า threshold 800ms เยอะ
- worker concurrency 15, queue drain < 5s สำหรับ 50 job

**ผลยืนยันหลัง fix (รันเดียวกันทุกอย่าง):**

| metric | ก่อน | หลัง |
|---|---|---|
| `checks_failed` | 0.14-0.24% | **0.00%** (0/953,544) |
| `http_req_failed` | 0.14-0.24% | **0.00%** (0/317,848) |
| `p95` | 506-602ms (เกิน threshold) | **373.3ms** (ผ่าน) |
| throughput | ~1,500 req/s | **~3,100 req/s** |

ทั้งสามบั๊ก (`worker_connections`, `backlog`, nginx CPU) เป็นคนละชั้นกัน ต้องแก้ครบทั้งสามตัวถึงหาย — แก้แค่ 2 ตัวแรกไม่พอ เพราะตัวที่ทำให้เกิด timeout จริงคือ CPU throttling ล้วนๆ

