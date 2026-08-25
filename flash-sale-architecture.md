# Flash Sale System — Architecture & Design Rationale (v2)

เอกสารออกแบบระบบสำหรับ Final Assignment (mobile 240-331)
เวอร์ชันปรับปรุงจากการวิเคราะห์ scale จริง (500 users) เทียบกับทรัพยากรเครื่องจริง (4 vCPU / 6GB RAM)
เปลี่ยนจาก v1 หลัก: **รวม Redis เหลือ 1 instance** (จากเดิมแยก cache/queue) เพราะที่ scale นี้การแยกเป็น over-engineering ที่แลกด้วย resource และเวลาโดยไม่ได้ throughput เพิ่มจริง

---

## 0. หลักคิดที่ใช้ตัดสินใจทุกอย่างในเอกสารนี้

### 0.1 คะแนนอยู่ตรงไหน

| ส่วน | ให้คะแนน performance? | กลยุทธ์ |
|---|---|---|
| `POST /auth/token` | ไม่ | แค่ต้องไม่ล้มที่ 500 users |
| `GET /products` | **ใช่ (หนักสุด)** | ต้องไม่แตะ Postgres เลยใน steady state |
| `POST /orders` | **ใช่ + ตรวจความถูกต้อง** | ต้อง reject ให้เร็ว และ commit ให้ถูกต้อง 100% |

### 0.2 หลักคิดที่แก้จาก v1: อย่า over-engineer เกิน scale ที่ต้องรองรับ

v1 แยก Redis เป็น cache/queue สองตัวด้วยเหตุผลกลัว event-loop contention ระหว่างสอง workload — เหตุผลนี้ถูกต้องในทางทฤษฎีแต่ **ผิดขนาด** สำหรับงานนี้ Redis เดี่ยวทำ simple command ได้ระดับแสนครั้งต่อวินาที ขณะที่ระบบทั้งหมดมี load รวมหลักพันครั้งต่อวินาทีที่ peak (1,000 concurrent read + 500 concurrent write) ห่างจากจุดที่ contention จะเริ่มมีผลเป็นระดับความจริงจังคนละขนาด

บนเครื่อง 4 vCPU / 6GB การแยก container เพิ่มมี **ต้นทุนจริงที่จับต้องได้**: baseline RAM ต่อ container, จุด debug เพิ่ม, ความเสี่ยง OOM-kill เพิ่มตามสัดส่วนจำนวน service — ขณะที่ประโยชน์ที่ได้กลับมาแทบวัดไม่ออกที่ scale นี้ resource ที่ประหยัดได้จากการรวมเอาไปเพิ่มให้ Postgres (จุดที่ CPU-sensitive จริง) และเผื่อ headroom กัน crash กลาง demo มีประโยชน์กว่ามาก

**หลักที่ใช้ทั่วทั้งเอกสาร:** ทุก component ที่เพิ่มเข้าไปต้องตอบได้ว่า "ที่ 500 users บนเครื่องนี้ มันแก้ปัญหาอะไรที่วัดผลได้จริง" ถ้าตอบไม่ได้ให้ตัดออก

### 0.3 อีกเหตุผลที่สำคัญไม่แพ้กัน: อาจารย์ตรวจ NestJS มากกว่า infra

วิชานี้คือ backend/NestJS บทเรียน 01-06 เน้นย้ำเรื่อง Module/Controller/Service, DI, DTO validation, transaction, locking, queue processor ตลอด — นี่คือของที่ให้คะแนนจริง ส่วนจำนวน container ใน `docker-compose.yml` ไม่ใช่หัวข้อในบทไหนเลย

ดังนั้นเอกสารนี้จงใจ **ลดความซับซ้อนของ infra ให้เหลือน้อยที่สุดเท่าที่ยังถูกต้อง** เพื่อเอาเวลาไปลงกับคุณภาพโค้ด NestJS แทน — unit test ที่ mock ถูกต้อง, exception handling ที่ครบ (23505/40P01 ตามบทที่ 03), DTO validation ที่รัดกุม, DI ที่ swap ได้จริงตามแนวทางบทที่ 02

---

## 1. องค์ประกอบระบบ และเหตุผลของแต่ละตัว

### 1.1 Nginx — Load Balancer

**เทคนิคที่ใช้และเหตุผล:**

```nginx
upstream api {
    least_conn;
    server api1:3000 max_fails=3 fail_timeout=10s;
    server api2:3000 max_fails=3 fail_timeout=10s;
    server api3:3000 max_fails=3 fail_timeout=10s;
    keepalive 128;
}
server {
    listen 80;
    access_log off;
    location / {
        proxy_pass http://api;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
    }
}
```

- `keepalive 128` + `proxy_http_version 1.1` + `Connection ""` — ป้องกัน Nginx เปิด TCP connection ใหม่ไปหา backend ทุก request ถ้าไม่ใส่ ตอนยิง 1,000 concurrent จะเจอ TIME_WAIT socket เต็มและ p95 พุ่ง
- `access_log off` — ตัด disk I/O ที่ไม่มีใครอ่านออกจาก hot path
- `least_conn` ไม่ใช้ `ip_hash` — k6 ยิงจาก IP เดียว ip_hash จะกองลง instance เดียวหมด

### 1.2 NestJS + Fastify — Backend (3 instances)

**เทคนิคที่ใช้และเหตุผล:**

- **`FastifyAdapter` แทน Express** — เปลี่ยนแค่บรรทัดเดียวใน `main.ts` โครงสร้าง module/controller/service เหมือนเดิมทุกอย่าง ไม่กระทบคะแนนส่วน architecture แต่ได้ JSON serializer ที่เร็วกว่า
- **ปิด global `ValidationPipe` บน `GET /products`** — parse `page`/`limit` เองแทน `class-validator` reflection ที่แพงเกินความจำเป็นสำหรับงานง่ายขนาดนี้ ยังเปิด ValidationPipe ไว้กับ `POST /orders` และ `/auth/token` เพื่อคงคะแนนส่วน DTO validation
- **ไม่ใช้ Passport สำหรับ JWT** — เขียน `JwtGuard` เองที่เรียก `jwt.verify()` ตรงๆ เบากว่า Passport strategy layer
- **ปิด Nest Logger บน hot path** — log level `warn` ตอน production

### 1.3 Worker — แยก container ออกจาก API (ยืนยันเหมือน v1)

**ยังคงแยกเพราะเหตุผลนี้จำเป็นจริง ไม่ใช่ over-engineering:** ถ้ารัน BullMQ processor อยู่ในโปรเซสเดียวกับ API instance มันจะแย่ event loop จาก request handler ตอนที่ k6 ยิงหนักที่สุด — ต่างจากการแยก Redis ตรงที่ Node.js เป็น single-threaded จริง งานประมวลผล job (เปิด transaction, รอ lock) เป็นงานที่ block event loop ได้จริง ไม่ใช่แค่ I/O เบาๆ แบบ Redis command

รันเป็น service แยกใน `docker-compose.yml` (image เดียวกับ API แต่ bootstrap คนละ mode ผ่าน `ROLE=worker`) — API instance ทำหน้าที่แค่ enqueue เท่านั้น

### 1.4 Redis — 1 instance, แยกด้วย key namespace (เปลี่ยนจาก v1)

**เทคนิคที่ใช้และเหตุผล:**

รวม cache กับ queue ไว้ใน Redis ตัวเดียว แยกโซนด้วย key prefix แทนการแยก container:

| Namespace | ใช้ทำอะไร |
|---|---|
| `cache:template:{page}:{limit}` | response template ที่ serialize ไว้แล้ว |
| `cache:stock:{productId}` | สต็อกคงเหลือแบบ real-time |
| `cache:claim:{productId}` | userId ที่จองสิทธิ์ไปแล้ว |
| `bull:*` | BullMQ ใช้ prefix นี้แยกโซนให้อัตโนมัติผ่าน `queuePrefix` config |

**ทำไมถึงรวม (ต่างจาก v1):**
- Load รวมของทั้งระบบอยู่ระดับหลักพัน ops/วินาทีที่ peak ห่างจากจุดที่ single-thread contention จะเริ่มมีผลมาก
- ประหยัด baseline RAM ~50-80MB และลดจุด debug ลง 1 container บนเครื่องที่ RAM ทุก MB มีความหมาย
- โค้ด application (Lua script, cache-aside, invalidation) เหมือนเดิมทุกบรรทัด ไม่ต้องแก้ business logic ใดๆ

**สิ่งที่ต้องเผื่อจากการรวม:** เปิด persistence ไว้ทั้งก้อน (เพราะ queue data อยู่ตัวเดียวกับ cache แล้ว ต่างจาก v1 ที่ปิด persistence ฝั่ง cache ได้) — เป็น trade-off เดียวที่เสียไป ไม่กระทบ correctness หรือ performance ที่ scale นี้

**`enableAutoPipelining: true`** ใน ioredis client — เปิดไว้เพื่อรวบคำสั่งที่เกิดในเวลาไล่เลี่ยกันส่งเป็นชุดเดียว มีผลตอน 1,000 concurrent

**เมื่อไหร่ถึงควรแยกจริง (บันทึกไว้เป็น documented trade-off):** ถ้า concurrent users ขึ้นถึงหลักหมื่น หรือ queue มี job หนักระดับ ETL/batch ไม่ใช่ fire-and-forget เล็กๆ แบบนี้ ตอนนั้นการแยกจะเริ่มให้ประโยชน์วัดผลได้จริง

### 1.5 PostgreSQL + TypeORM

**เทคนิคที่ใช้และเหตุผล:**

- **`SELECT ... FOR UPDATE` (pessimistic lock)** ไม่ใช้ optimistic — เหตุผลผูกกับ contention pattern ของระบบนี้โดยตรง: ทุก job ที่มาถึง worker แย่ row เดียวกัน (`p-1001`) ถ้าใช้ optimistic lock (`@VersionColumn` + retry) ยิ่ง concurrent สูงยิ่ง retry ถี่ ระบบเข้าสู่ thrashing (เสีย CPU กับงานที่ถูกทิ้ง) ส่วน pessimistic ทำให้ transaction ที่มาทีหลังแค่รอในคิวเรียบร้อย ไม่มี retry ไม่มี CPU เสียเปล่า และเพราะ Lua script ที่ Redis กรองจาก 500 requests เหลือแค่ ~50 ที่มาถึง worker จริง contention จริงจึงต่ำ pessimistic lock จึงไม่แพงในระบบนี้
- **`UNIQUE (user_id, product_id)`** — ตาข่ายชั้นสุดท้าย ในทางปฏิบัติไม่ถูกกระตุ้นเลยเพราะ Redis กันไปแล้ว แต่ต้องมีเพื่อพิสูจน์ว่าถูกต้องแม้ Redis พัง
- **`CHECK (remaining_stock >= 0)`** — บังคับที่ระดับ schema
- **Connection pool เล็ก** — read path ไม่แตะ DB เลย: `3 API × pool 5 + worker × pool 10 = 35` < `max_connections=60` ที่ตั้งไว้ (ดูหัวข้อ 1.7)
- **ไม่ทำ read replica** — read ไม่แตะ DB เลยในระบบนี้ replica จะไม่มีงานทำ เพิ่มความซับซ้อนโดยไม่ได้อะไร (ต่างจากบทที่ 06 ที่ไม่มี cache layer กั้น replica จึงช่วยได้จริง)

### 1.6 JWT — Stateless Authentication

- **HS256** ไม่ใช่ RS256 — symmetric key เร็วกว่าในการ verify และไม่มี third party ต้อง verify ด้วย public key
- **payload เล็กที่สุด** — แค่ `{ sub: userId }` + `exp`
- **Verify-cache ด้วย Map** — user บางคนยิงซ้ำ 2-3 ครั้งด้วย token เดิม ใช้ LRU Map เก็บ `token → userId` (TTL สั้น) ตัด HMAC ซ้ำออกจาก request ที่ 2 เป็นต้นไป
- **ไม่มี DB lookup ใน guard** — `/auth/token` แค่ sign token คืนไปเลย

### 1.7 Observability

- **Bull-Board** mount ที่ worker container ไม่ใช่ API เพื่อไม่ให้ dashboard ที่ poll ตลอดเวลารบกวน instance ที่ถูกวัดคะแนน
- **`GET /api/v1/_metrics`** — สรุป cache hit/miss, orders accepted/duplicate/soldout, queue depth
- **นับ metric ใน memory แล้ว flush ขึ้น Redis ทุก 1 วินาที** — ไม่ `INCR` ไป Redis ทุก request เพราะเป็นการเพิ่ม round trip เข้าไปในเส้นทางที่กำลังพยายามลด round trip

---

## 2. Resource Budget (4 vCPU / 6GB RAM)

| Service | CPU | RAM |
|---|---|---|
| `nginx` | 0.25 | 64MB |
| `api1` `api2` `api3` | 0.65 ต่อตัว | 350MB ต่อตัว |
| `worker` | 0.5 | 300MB |
| `postgres` | 1.0 | 900MB |
| `redis` | 0.4 | 350MB |
| **รวม** | **~4.05** | **~2.75GB** |

เหลือ RAM ~3.25GB ให้ host OS และกันสำรองตอน spike — ถ้า container ถูก OOM-kill กลาง load test ผลทดสอบทั้งชุดพังทันที เป็นความเสี่ยงที่สำคัญกว่าเรื่อง throughput ไม่พอ

**ป้องกัน OOM ระหว่างยิง:**

```yaml
api1:
  environment:
    NODE_OPTIONS: "--max-old-space-size=220"
  deploy:
    resources:
      limits:
        cpus: "0.65"
        memory: 350M
```

`max-old-space-size` ตั้งไว้ที่ ~60-65% ของ `mem_limit` เพื่อเผื่อ native buffer/stack นอก heap

**Postgres ต้องตั้งเองเพราะไม่รู้จัก cgroup limit อัตโนมัติ:**
```
-c shared_buffers=192MB
-c max_connections=60
-c work_mem=4MB
```

**เครื่อง Host:** แนะนำ Debian (netinst, ไม่ใช่ desktop) เพราะ baseline RAM เบากว่า Ubuntu Server อย่างชัดเจน (~80-150MB vs ~250-400MB เพราะ snapd/cloud-init) ที่ scale นี้ RAM ทุก MB มีความหมาย ถ้าทีมถนัด Ubuntu อยู่แล้วให้ปิด snapd และล้าง cloud-init ทิ้งตอน provision

---

## 3. Data Model

### 3.1 PostgreSQL

```sql
CREATE TABLE products (
  product_id         VARCHAR(20) PRIMARY KEY,
  name               VARCHAR(200) NOT NULL,
  description        TEXT,
  price              NUMERIC(10,2) NOT NULL,
  available_stock    INT NOT NULL,
  remaining_stock    INT NOT NULL CHECK (remaining_stock >= 0),
  is_flash_sale_active BOOLEAN NOT NULL DEFAULT false
);

CREATE TABLE orders (
  id          BIGSERIAL PRIMARY KEY,
  user_id     VARCHAR(50) NOT NULL,
  product_id  VARCHAR(20) NOT NULL REFERENCES products(product_id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_user_product UNIQUE (user_id, product_id)
);
```

**หมายเหตุเรื่อง seed:** `products-seed.json` ไม่มีฟิลด์ `remainingStock` — ตอน seed ให้ตั้ง `remaining_stock = available_stock` เพราะ flash sale ยังไม่เริ่ม `available_stock` = โควตาที่จัดสรรไว้ (คงที่), `remaining_stock` = เหลือเท่าไหร่ (ลดลงเรื่อยๆ)

### 3.2 Redis keys (namespace เดียวกันหมด ตัวเดียว)

| Key | Type | ใช้ทำอะไร |
|---|---|---|
| `cache:stock:{productId}` | String (int) | สต็อกคงเหลือแบบ real-time |
| `cache:claim:{productId}` | Set | userId ที่จองสิทธิ์ไปแล้ว |
| `cache:template:{page}:{limit}` | String | response template ที่ serialize ไว้แล้ว |
| `cache:m:*` | String (int) | metrics counter |
| `bull:*` | mixed | BullMQ internal state |

**การ seed `cache:stock:*` ต้องใช้ `SET NX`** ไม่ใช่ `SET` ธรรมดา — ถ้า API instance restart กลางการทดสอบแล้ว seed ทับ สต็อกจะเด้งกลับเป็น 50 และผลทดสอบจะพัง

---

## 4. Read Path — `GET /api/v1/products`

### 4.1 ปัญหาที่ต้องแก้

โจทย์วางกับดักไว้ตรงที่ต้อง cache เพื่อความเร็ว แต่ `remainingStock` ต้องถูกต้องเสมอ วิธี naive คือ cache ทั้งหน้าแล้วลบ cache ทุกครั้งที่สต็อกเปลี่ยน — จะพังเพราะระหว่างที่ 1,000 VU กำลังยิงอยู่ ทุกครั้งที่ worker ตัดสต็อก cache จะหาย แล้ว request หลายร้อยตัวจะวิ่งเข้า Postgres พร้อมกัน (**cache stampede**) เกิดขึ้น 50 ครั้งตลอดการทดสอบ

### 4.2 ทางแก้: แยก cache ตามอัตราการเปลี่ยนแปลง

- **แทบไม่เปลี่ยน:** `productId`, `name`, `price`, `availableStock`, `isFlashSaleActive` — เก็บเป็น response template ที่ pre-split เป็นชิ้นๆ ตรงตำแหน่งที่ตัวเลขสต็อกต้องไปวาง
- **เปลี่ยนตลอดเวลา:** `remainingStock` — อ่านจาก `cache:stock:*` ด้วย `MGET` ทุก request ไม่มีวัน stale

```ts
type PageTemplate = { segments: string[]; ids: string[] };

const stocks = await redis.mget(tpl.ids.map(id => `cache:stock:${id}`));
let out = tpl.segments[0];
for (let i = 0; i < stocks.length; i++) out += stocks[i] + tpl.segments[i + 1];
return out;  // ส่งเป็น string ตรงๆ ไม่ต้อง serialize
```

**ทำไมถึงเร็ว:** ไม่มี `JSON.parse`/`JSON.stringify` เลย (CPU cost ที่ใหญ่ที่สุดของ JSON API), 1 Redis round trip ต่อ request, ไม่ต้อง invalidate อะไรเวลาสต็อกเปลี่ยนเพราะสต็อกไม่เคยอยู่ใน cache ตั้งแต่แรก — ไม่มี cache stampede ได้ในเชิงโครงสร้าง

### 4.3 L1 in-process cache

`segments`/`ids` ไม่เปลี่ยนตลอด flash sale เก็บใน memory ของแต่ละ instance (Map ธรรมดา) หลัง warm-up แล้ว request ที่ hit เหลือแค่ Redis `MGET` หนึ่งครั้ง ไม่แตะทั้ง Postgres และ template

**ตัวเลือกเสริม (aggressive mode, ทำเป็น env flag):** cache response string ที่ compose เสร็จแล้วทั้งก้อน TTL 50-100ms เหลือ 0 round trip แต่สต็อก stale ได้ไม่เกิน TTL — วัดทั้งสองแบบใส่รีพอร์ตเป็นตารางเทียบ

### 4.4 Pagination และการป้องกัน input มั่ว

```ts
const page  = Math.max(1, parseInt(q.page)  || 1);
const limit = Math.min(100, Math.max(1, parseInt(q.limit) || 10));
```

- `limit=abc`, `page=-5` → fallback เป็น default ไม่ใช่ 500
- `page=99999` → ตอบ 200 พร้อม `data: []`
- **clamp `limit` ที่ 100** กัน cache key explosion
- `meta.totalPages = Math.ceil(20 / limit)` ต้องตรงเป๊ะ เพราะสคริปต์กลุ่มอื่นน่าจะ `check()` ตรงนี้

### 4.5 Warm-up

ตอน bootstrap prebuild template ของชุด `(page, limit)` ที่น่าจะถูกยิงบ่อย เพื่อไม่ให้เจอ cold miss ตอน k6 เริ่มยิง

---

## 5. Write Path — `POST /api/v1/orders`

### 5.1 Lua script เดียวที่ atomic

```lua
-- KEYS[1] = cache:claim:{productId}   ARGV[1] = userId
-- KEYS[2] = cache:stock:{productId}
if redis.call('SADD', KEYS[1], ARGV[1]) == 0 then
  return -1                                    -- ซื้อซ้ำ
end
local left = redis.call('DECR', KEYS[2])
if left < 0 then
  redis.call('INCR', KEYS[2])
  redis.call('SREM', KEYS[1], ARGV[1])         -- คืนสิทธิ์ให้ตัวเอง
  return -2                                    -- ของหมด
end
return left                                    -- สำเร็จ
```

**ทำไมออกแบบแบบนี้:** 1 round trip ได้ทั้ง duplicate check และ stock reservation, atomic จริง, `SADD` ก่อน `DECR` เสมอ (ถ้าสลับ user ที่ยิงซ้ำจะแย่งสต็อกจากคนอื่นก่อนแล้วค่อยรู้ตัวว่าซื้อซ้ำ) และ `SADD` ทำหน้าที่เป็น idempotency key ในตัว ไม่ต้องมี `SETNX` lock แยกที่มีปัญหา TTL หมดอายุกลางคัน

### 5.2 ผลลัพธ์ของดีไซน์นี้

จาก 500+ requests เหลือแค่ **50 job** ที่เข้าคิว ที่เหลือถูกปฏิเสธที่ Redis ภายในไม่กี่ไมโครวินาที → Postgres เห็นแค่ 50 transaction, contention บน row `p-1001` แทบไม่มี → ใช้ pessimistic lock ได้อย่างสบายใจ

### 5.3 การ enqueue

```ts
await queue.add('deduct', { userId, productId }, {
  jobId: `${userId}:${productId}`,   // deterministic → BullMQ กันซ้ำอีกชั้น
  removeOnComplete: true,
  removeOnFail: 1000,
  attempts: 3,
  backoff: { type: 'exponential', delay: 200 },
});
```

ตอบ `202` ทันทีหลัง `add()` return — ห้ามรอผล job

### 5.4 Worker

```ts
await dataSource.transaction(async (m) => {
  const p = await m.findOne(Product, {
    where: { productId },
    lock: { mode: 'pessimistic_write' },
  });
  if (p.remainingStock < 1) throw new UnrecoverableError('sold out');
  p.remainingStock -= 1;
  await m.save(p);
  await m.save(m.create(Order, { userId, productId }));
});
```

ทั้งการหักสต็อกและ insert order อยู่ใน transaction เดียวผ่าน `manager` ตัวเดียวกัน `concurrency` ตั้งประมาณ 10-20 พอ ตั้งสูงกว่านี้ไม่ช่วยเพราะทุก job รอ lock ของ row เดียวกันอยู่ดี

### 5.5 Cache Invalidation ที่ spec บังคับ

| ข้อมูล | กลยุทธ์ | เหตุผล |
|---|---|---|
| `remainingStock` | **ไม่ invalidate** — อ่านจาก `cache:stock:*` ตรงๆ ทุก request | เปลี่ยนถี่เกินกว่า invalidation จะคุ้ม |
| ข้อมูลสินค้าอื่น | **invalidate ทันทีหลัง DB commit** ลบ `cache:template:*` | เปลี่ยนน้อยมาก การลบทั้งหน้าจึงถูกและปลอดภัย |

ลบ**หลัง**commit สำเร็จเท่านั้น ไม่ใช่ก่อน — ป้องกันหน้าต่างที่ request อื่นมา re-populate cache ด้วยข้อมูลเก่า

---

## 6. Failure Mode และการชดเชย

**Redis กับ Postgres จะไม่ตรงกันชั่วขณะเสมอ** — Redis counter คือ "จองแล้ว" Postgres คือ "ยืนยันแล้ว" (reservation pattern, ไม่ใช่ bug) แต่ต้องจัดการตอน job ไม่สำเร็จ:

| สถานการณ์ | ทำอะไร | เหตุผล |
|---|---|---|
| Job fail จน attempts หมด | `INCR cache:stock` + `SREM cache:claim` ใน `onFailed` | ไม่คืน = สต็อกหายถาวร = สอบตกข้อ Data Integrity |
| Unique violation `23505` | `UnrecoverableError` ไม่ retry, **ไม่คืนสต็อก** | user คนนี้ได้ของไปแล้วจริง |
| Job สำเร็จ | ไม่ต้องทำอะไร | Redis หักไปตั้งแต่ enqueue แล้ว |

หลังจบ load test: `cache:stock:p-1001` = `products.remaining_stock` = 0 และ `COUNT(orders)` = 50 ต้องตรงกันทั้งสามค่า

---

## 7. `docker-compose.yml` — รายการ service (7 ตัว)

| Service | Image | หมายเหตุ |
|---|---|---|
| `nginx` | nginx:alpine | port 80 ออกสู่ภายนอก |
| `api1` `api2` `api3` | build (multi-stage) | `ROLE=api`, pool 5 |
| `worker` | image เดียวกับ api | `ROLE=worker`, pool 10, mount Bull-Board |
| `postgres` | postgres:18-alpine | healthcheck `pg_isready` |
| `redis` | redis:7-alpine | persistence เปิด (มี queue data) |
| `migrate` | image เดียวกับ api | one-shot: migration + seed แล้วจบ |

ทุก `depends_on` ต้องใช้ `condition: service_healthy` ไม่ใช่แค่ `depends_on` เฉยๆ

Dockerfile ใช้ multi-stage ตามบทที่ 01 (`builder` → `production` + `USER node`)

---

## 8. Mapping กลับไปที่บทเรียน (สำหรับรีพอร์ต)

| เทคนิคในระบบนี้ | มาจากบท |
|---|---|
| Multi-stage Dockerfile, `USER node` | 01 |
| Module/Controller/Service, DTO validation, DI | 02 |
| `pessimistic_write` ใน transaction เดียว, unique constraint, migration | 03 |
| Cache-aside, invalidation หลัง commit, atomic op (`DECR`/`SADD`) | 04 |
| BullMQ, `UnrecoverableError` vs retry, Bull-Board, dead letter | 05 |
| Nginx LB, 3 instances, stateless JWT, pool sizing, structured log | 06 |

**จุดที่ต่างจากบทเรียน และเหตุผล (ควรเขียนในรีพอร์ต เพราะแสดงว่าเข้าใจ ไม่ใช่ทำตามสูตร):**
- ไม่ทำ read replica — read ไม่แตะ DB เลย replica จะไม่มีงานทำ
- ไม่แยก Redis เป็น 2 container — ที่ scale 500 users contention ไม่ถึงจุดที่ต้องแยก, ประหยัด resource ไปเผื่อ Postgres แทน
- ไม่ใช้ `SETNX` lock แต่ใช้ `SADD` — ไม่มีปัญหา TTL หมดอายุกลางคัน
- ไม่ใช้ pub/sub สำหรับงานตัดสต็อก — บทที่ 05 เตือนไว้ว่า multi-instance จะทำงานซ้ำ

---

## 9. Load Test และสิ่งที่ต้องพิสูจน์

**Preparation:** ขอ token 500 ใบ (`user-1`…`user-500`) ใน `setup()` ของ k6

**Read scenario:** 1,000 VU ยิง `GET /products?page=1&limit=10` + สลับ `page`/`limit` บ้าง

**Write scenario:** 500 VU ยิง `POST /orders` ชิง `p-1001` โดยให้บาง VU ยิง 2-3 ครั้งซ้อน

**ตัวเลขที่ต้องเก็บ:** cache hit/miss ratio (L1/L2), queue completed/failed/waiting, req/s, p95, error rate

**หลักฐานความถูกต้อง:**
```sql
SELECT remaining_stock FROM products WHERE product_id = 'p-1001';  -- ต้องได้ 0 พอดี
SELECT COUNT(*) total, COUNT(DISTINCT user_id) uniq
FROM orders WHERE product_id = 'p-1001';                            -- ต้องได้ 50 / 50
```

**ข้อควรระวัง:** ต้อง reset ระบบ (truncate orders + reset stock ทั้ง DB และ Redis) ก่อนยิงทุกครั้ง

**Instance count sweep (แนะนำใส่ในรีพอร์ต):** ทดลอง 3 vs 4 instances แล้วดูว่า req/s ต่างกันจริงไหมบนเครื่อง 4 vCPU นี้ — ถ้าไม่ต่างกันมาก แสดงว่าชนเพดาน CPU ของเครื่องแล้ว ไม่ใช่เพดานของ instance count เป็นหลักฐานเชิงประจักษ์ที่ดีกว่าการเดา

---

## 10. ข้อเสนอการแบ่งงาน 3 คน

| คน | ขอบเขต | ส่งมอบ |
|---|---|---|
| A — Infrastructure | docker-compose, Nginx, Dockerfile, Postgres, migration + seed, health check, pool sizing | ระบบ 1-click start ที่ขึ้นครบทุก service |
| B — Read path | products module, template cache, L1, pagination + input validation, metrics endpoint | `GET /products` ที่ไม่แตะ DB ใน steady state |
| C — Write path | auth + JWT guard, orders controller, Lua script, BullMQ, worker, compensation, Bull-Board | `POST /orders` ที่ผ่าน integrity test |

งานร่วม: k6 script, การรันทดสอบ, รีพอร์ต — A ควรเสร็จก่อนใน 2 วันแรกเพราะอีกสองคนถูกบล็อกอยู่

---

## 11. Checklist ก่อนส่ง

- [ ] `docker compose up` ครั้งเดียวขึ้นครบ ไม่ต้องรันคำสั่งเสริม
- [ ] ยิง `page`/`limit` มั่วๆ แล้วไม่มี 500 หลุดออกมา
- [ ] field ใน response ตรง spec ทุกตัว
- [ ] `remaining_stock` = 0 พอดี, orders = 50 unique users
- [ ] ยิงทดสอบซ้ำได้หลังรีเซ็ต โดยได้ผลเหมือนเดิม
- [ ] Bull-Board เข้าถึงได้และมีตัวเลขให้แคป
- [ ] ตั้ง `mem_limit` + `NODE_OPTIONS` ครบทุก service ก่อนยิงจริง (กัน OOM-kill กลาง demo)
- [ ] k6 script ยิง API ของกลุ่มอื่นได้โดยเปลี่ยนแค่ base URL
- [ ] unit test มี mock ที่ไม่แตะ DB/Redis จริง อย่างน้อย 1 ชุดต่อ module (คะแนนส่วน NestJS)