# Flash Sale System — Architecture and Current Implementation

เอกสารนี้อัปเดตตรงกับระบบที่อยู่ใน repo ปัจจุบัน โดยยึดตามโค้ดจริงใน `backend/src` และ `deploy/docker-compose.yml` ไม่ใช่ design แบบแนวคิดเก่าที่ยังค้างอยู่ในสเปก

---

## 1. ภาพรวมระบบ

ระบบนี้ถูกออกแบบให้ใช้ 1 Redis instance, 1 Postgres instance, Nginx reverse proxy, 6 API instances และ 1 worker process แยกออกจาก HTTP API เพื่อให้การจัดการ write burst และ queue processing ไม่รบกวน hot path ของ request

สถาปัตยกรรมหลัก:

- `nginx` เป็น edge reverse proxy / load balancer
- `api1`–`api6` รัน NestJS ด้วย Fastify
- `worker` รัน NestJS ใน mode `ROLE=worker` เพื่อประมวลผล BullMQ jobs
- `postgres` เป็น source of truth สำหรับ product และ order
- `redis` ใช้สำหรับ cache-aside, temporary reservation, metrics, และ BullMQ state
- `migrate` เป็น one-shot migration + seed

ประเด็นสำคัญที่ทำให้ระบบนี้ต่างจาก design แบบเดิมคือ:

- product page cache ใช้ template cache + live stock splice จาก Redis
- cache miss ถูก coalesce ด้วย Redis lock และ in-process single-flight
- ไม่มี response cache ทั้งหน้าแบบ TTL ข้าม request
- write path ใช้ Lua reservation + BullMQ worker + compensation on retry exhaustion
- `cache:stock:*` เป็น real-time source สำหรับ `remainingStock` ไม่ได้ invalidates ทุกครั้ง

---

## 2. Runtime topology

### 2.1 Nginx

`nginx` อยู่ก่อน API และทำหน้าที่ round-robin ไปยัง 6 api instances โดยไม่ใช้ edge cache

ข้อสังเกตจาก config ปัจจุบัน:

- `nginx.conf` ทำ static upstream pool ไปยัง `api1` ถึง `api6`
- `keepalive` และ `proxy_http_version 1.1` ถูกตั้งไว้เพื่อลด socket churn
- access log ถูกปิด/จำกัดเพื่อลด I/O ใน hot path
- worker ก็ถูก proxy ผ่าน nginx ที่ `/admin/queues` เพื่อไม่ให้ dashboard รบกวน API process

### 2.2 NestJS + Fastify

API instances ถูกสร้างด้วย:

```ts
const app = await NestFactory.create<NestFastifyApplication>(
  AppModule,
  new FastifyAdapter({ logger: false, disableRequestLogging: true }),
);
```

และมี global ValidationPipe:

```ts
const validationPipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
});
```

สิ่งที่เป็นจริงในโค้ดตอนนี้:

- ใช้ Fastify แทน Express
- `POST /orders` และ `/auth/token` ยังใช้ DTO validation ผ่าน ValidationPipe
- `GET /products` ไม่ใช้ reflection-heavy validation แบบ naive แต่จัดการ `page` / `limit` ใน service เอง
- ไม่มี Passport JWT layer; ใช้ custom guard ที่เรียก `jwt.verify()` โดยตรง
- logger ถูกปิดบน hot path เพื่อให้ throughput ดีขึ้น

### 2.3 Worker model

Worker เริ่มจาก `ROLE=worker` และ mount Bull-Board สำหรับ queue dashboard:

```ts
if (role === 'worker') {
  const queue = app.get<Queue>(getQueueToken('orders'));
  await mountBullBoard(...);
  await app.listen(port, '0.0.0.0');
}
```

Worker รันแยกจาก API เหตุผลว่า:

- Node.js เป็น single-threaded
- processing job ที่ทำ DB transaction + lock จะ block event loop หากอยู่ใน same process
- queue worker อาจทำงานทับกับ request load ได้จริง จึงแยก container ออกมา

---

## 3. Product read path

### 3.1 รูปแบบ cache ที่ใช้จริง

Read path ไม่ใช่ “cache page ทั้งก้อนแล้วลบทุกครั้ง” แบบเก่า แต่เป็น template cache ที่คั่นระหว่างข้อมูลที่เปลี่ยนช้าและข้อมูลที่เปลี่ยนเร็ว:

- ข้อมูลที่แทบไม่เปลี่ยน: `productId`, `name`, `price`, `availableStock`, `isFlashSaleActive`
- ข้อมูลที่เปลี่ยนตลอด: `remainingStock`

โค้ดใช้ key แบบนี้:

```ts
const TPL_KEY = (page: number, limit: number) => `cache:products:tpl:${page}:limit:${limit}`;
const TPLKEYS_SET = 'cache:products:tplkeys';
```

`buildBlob()` สร้าง template JSON แล้วแทน `remainingStock` ด้วย placeholder เช่น `@@RS0@@` เพื่อให้ render phase ใส่ stock จริงจาก Redis ในทุก request

### 3.2 Single-flight และ lock

สำหรับ hot path ที่มีการ miss เดียวกันจากหลาย instance โค้ดใช้:

- in-process `Map<string, Promise<string>>` สำหรับ single-flight ใน instance เดียว
- Redis lock `lock:${pageKey}` ภายใน `buildCoalesced()`
- TTL 5s และ polling timeout 3s

เหตุผลคือ:

- Nginx round-robin ทำให้ multi-instance miss เกิดพร้อมกัน
- `Map` อย่างเดียวไม่เพียงพอ เพราะหลาย instance จะ build ซ้ำ
- Redis lock รวมการ build ให้เป็น 1 build ต่อ page template ภายใน cluster

### 3.3 Render path

`render()` ทำงานแบบนี้:

```ts
const stocks = await this.redis.mget(ids.map((id) => `cache:stock:${id}`));
let out = segments[0];
for (let i = 0; i < ids.length; i++) {
  out += (stocks[i] != null ? stocks[i] : dbStock[i]) + segments[i + 1];
}
return out;
```

จึงมีคุณสมบัติเหล่านี้:

- ไม่มี `JSON.parse` บน hot path
- ไม่มี object creation สำหรับ response ทั้งก้อน
- stock วางสดทุก request จาก `cache:stock:*`
- cache stampede ที่เกิดจาก invalidation แบบ cache page ทั้งหน้า ไม่เกิดใน path นี้

### 3.4 Invalidate logic

`invalidate()` ทำเพียง:

```ts
const keys = await this.redis.smembers(TPLKEYS_SET);
await this.redis.unlink(TPLKEYS_SET, ...keys);
```

หมายความว่า:

- ไม่ใช่ `DEL cache:template:*` แบบ broad scan
- ใช้ tracked set เพื่อให้ลบเฉพาะ template ที่เคยถูกสร้างจริง
- master data เช่น name/price/flag ถูก invalidate แบบ batch ใน Redis
- `remainingStock` ไม่ใช่ส่วนของ template จึงไม่ควร invalidates ทุกครั้ง

---

## 4. Write path

### 4.1 Lua reservation

โค้ดใน `orders.service.ts` ใช้ ioredis custom command `claimStock` พร้อม Lua script จาก `backend/src/orders/lua/claim-stock.lua`:

```lua
if redis.call('SADD', KEYS[1], ARGV[1]) == 0 then
  return -1
end
local left = redis.call('DECR', KEYS[2])
if left < 0 then
  redis.call('INCR', KEYS[2])
  redis.call('SREM', KEYS[1], ARGV[1])
  return -2
end
return left
```

หลักการทำงาน:

- `cache:claim:{productId}` เป็น set ของ user ที่เคย claim แล้ว
- `cache:stock:{productId}` เป็น remaining stock แบบ real-time
- `SADD` ตรวจ duplicate แบบ atomic
- `DECR` ลด stock แบบ atomic
- ค่าที่คืนกลับคือ `-1` = duplicate, `-2` = sold out, ตัวเลขอื่น = success

### 4.2 Queue enqueue behavior

เมื่อ claim success แล้ว ระบบจะ enqueue job ด้วย deterministic ID:

```ts
jobId: `${userId}|${productId}`
```

และตั้งค่า:

```ts
removeOnComplete: { count: 100 },
removeOnFail: { count: 100 },
attempts: 3,
backoff: { type: 'exponential', delay: 200 },
```

หมายถึง:

- duplicate request จะถูก reject ที่ Redis ก่อนถึง queue
- queue มองเห็นเฉพาะ request ที่จริง ๆ ผ่านการ claim
- Bull-Board จะแสดงจำนวนที่เหลือเพียง N job ล่าสุด

### 4.3 Worker transaction

Worker ใช้ pessimistic lock ใน `Product` row:

```ts
await this.dataSource.transaction(async (manager) => {
  const product = await manager.findOne(Product, {
    where: { productId },
    lock: { mode: 'pessimistic_write' },
  });
  if (!product || product.remainingStock < 1) {
    throw new UnrecoverableError('sold out');
  }
  product.remainingStock -= 1;
  await manager.save(product);
  await manager.save(manager.create(Order, { userId, productId }));
});
```

ถ้า DB เกิด duplicate / constraint violation จะ throw `UnrecoverableError` เพื่อไม่ retry

### 4.4 Compensation

ใน `@OnWorkerEvent('failed')`:

- ถ้า job หมด retry และยังเป็น transient failure → `cache:stock:{productId}` + 1 และ `SREM cache:claim:{productId}`
- ถ้า error เป็น `UnrecoverableError` (sold out / duplicate) → ไม่คืนสต็อกเพราะการจองมันเป็น final

นี้ตรงกับความจริงของ system: Redis จัดการ reservation, Postgres จัดการ confirmation, และ compensation ควรทำเฉพาะกรณีที่ job ล้มแบบ transient

---

## 5. Redis key layout

Key ที่ใช้อย่างเป็นทางการใน repo:

| Key pattern | Type | Purpose |
|---|---|---|
| `cache:stock:{productId}` | String | Remaining stock real-time |
| `cache:claim:{productId}` | Set | User IDs already claimed |
| `cache:products:tpl:{page}:limit:{limit}` | String | Product page template blob |
| `cache:products:tplkeys` | Set | Tracked template keys for invalidation |
| `cache:m:{metric}` | String | Metrics counters |
| `lock:{pageKey}` | String | Redis mutex for template build |
| `bull:*` | mixed | BullMQ internal state |

หมายเหตุสำคัญ:

- `seed.ts` ใช้ `SET ... NX` เพื่อไม่ให้ seed overwrite stock ที่มีอยู่แล้ว
- Redis มี `enableAutoPipelining: true` ใน provider
- metric ใช้ `MGET` แบบ fixed key list เพื่อหลีกเลี่ยง `KEYS cache:m:*` ที่ block Redis single-thread

---

## 6. PostgreSQL schema

Schema ปัจจุบันมีพื้นฐานดังนี้:

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

สิ่งที่ชัดเจนคือ:

- `UNIQUE (user_id, product_id)` ทำหน้าที่ defense-in-depth
- `remaining_stock >= 0` ถูกบังคับที่ database level
- read path ส่วนใหญ่ไม่ต้องติดต่อ DB ถึง steady-state
- worker ใช้ `pessimistic_write` lock ใน transaction ที่อ่าน product แล้วค่อย decrement

---

## 7. JWT and auth

`auth.service.ts` และ `jwt.guard.ts` ใช้ JWT แบบ stateless:

- algorithm: `HS256`
- verify ผ่าน `jwt.verify(token, secret, { algorithms: ['HS256'] })`
- payload เล็ก: `{ sub: userId }` + `exp`
- ไม่มี DB lookup ใน guard

สิ่งนี้เข้ากับ requirements ของระบบที่ต้องรับ request ต่อเนื่องโดยไม่ทำ database lookup เพิ่มเติม

---

## 8. Metrics and observability

`MetricsService` เก็บ counter ใน Redis แบบ fixed set:

- `cache_hit`
- `cache_miss`
- `cache_wait_hit`
- `cache_wait_timeout`
- `db_build`
- `orders_accepted`
- `orders_duplicate`
- `orders_soldout`
- `orders_completed`
- `orders_failed`

รูปแบบ snapshot:

- ใช้ `MGET` กับ key list ที่กำหนดไว้
- `stockSnapshot()` ใช้ `SCAN` + `MATCH 'cache:stock:*'` เพื่อหลีกเลี่ยง `KEYS` ที่ block Redis
- dashboard HTML อ่านข้อมูลเหล่านี้และแสดง live stock / queue health

---

## 9. Deployment configuration

`deploy/docker-compose.yml` ปัจจุบันมี topology จริง:

| Service | Role |
|---|---|
| `nginx` | reverse proxy |
| `api1` to `api6` | NestJS API instances |
| `worker` | BullMQ processor |
| `postgres` | DB |
| `redis` | cache + queue + counters |
| `migrate` | migration + seed |

ค่าความจำกัดจริงจาก compose:

- api limit: `cpus: "0.55"`, `memory: 424M`
- nginx limit: `cpus: "0.85"`, `memory: 128M`
- worker limit: `cpus: "0.35"`, `memory: 384M`
- postgres limit: `cpus: "0.25"`, `memory: 512M`
- redis limit: `cpus: "0.35"`, `memory: 512M`

Postgres config ปัจจุบัน:

```yaml
command: >
  postgres
  -c shared_buffers=192MB
  -c max_connections=120
  -c work_mem=4MB
  -c synchronous_commit=off
```

และ `AppModule` ตั้ง pool สำหรับแต่ละ role:

- API: `POSTGRES_POOL_API` default 5
- Worker: `POSTGRES_POOL_WORKER` default 10

---

## 10. Current design differences from an older “idealized” design

ความแตกต่างที่สำคัญระหว่าง system กับฉบับ conceptual แบบเก่าคือ:

1. Product template cache ใช้ key ที่ชื่อ `cache:products:tpl:*` ไม่ใช่ `cache:template:{page}:{limit}`
2. Redis mutex ใช้ `lock:{pageKey}` พร้อม polling logic ไม่ใช่ broad delete
3. invalidation ใช้ tracked set + `UNLINK` ไม่ใช่ `DEL cache:template:*` แบบดิบ
4. queue job ID ใช้ `userId|productId` แทน `${userId}:${productId}` เพื่อหลีกเลี่ยง colon ที่ BullMQ reserve ไว้
5. API instance จริงมี 6 ตัว ไม่ใช่ 3 ตัว
6. worker concurrency default เป็น `30`, ไม่ใช่ “10-20” แบบแนวคิด
7. dashboard และ metrics จะอ่านจาก Redis live state ไม่ใช่ in-memory flush ทุก 1s แบบผู้เขียนอ้างในสิ่งที่เก่า ๆ

สิ่งเหล่านี้ไม่ใช่ bug แต่มาจากการปรับ architecture ให้สอดคล้องกับ repo จริงที่รันอยู่

---

## 11. Verification checklist

รายการที่ควรยืนยันก่อนส่งหรือ present ให้ทีม:

- [ ] `docker compose up` เรียก service ทั้งหมดพร้อมใช้งาน
- [ ] API health check / worker health check / postgres / redis ปกติ
- [ ] `GET /products?page=1&limit=10` คืน JSON ที่มี field ครบและ `remainingStock` ถูกต้องตาม Redis
- [ ] `POST /orders` สำหรับ user เดียวกันและ product เดียวกันถูก reject ถูกต้อง
- [ ] จำนวน orders ที่ยืนยันใน Postgres เท่ากับ stock ที่จองจริงใน Redis
- [ ] Bull-Board เปิดได้ผ่าน nginx route
- [ ] worker compensation ทำงานเมื่อ retry หมดก่อนเกิน timeout
- [ ] unit tests ปกติสำหรับ `OrdersService` และ `ProductsService`

---

## 12. สรุป

ระบบนี้ใช้ architecture ที่ balance ระหว่าง correctness และ throughput:

- Redis เป็น source ของ live stock และ template cache
- queue worker แยกออกจาก API process
- Postgres เป็น source of truth และทำ transaction lock แบบ pessimistic
- `GET /products` ไม่มีการทำ DB read ใน steady state เมื่อ template cache hit
- `POST /orders` ใช้ reservation pattern เพื่อให้ reject fast และ prevent duplicate claims

จุดสำคัญคือ architecture นี้เป็น “current implementation” ของ repo มากกว่าความคิดเชิง Idealized ว่าจะต้องเป็นแบบไหน ดังนั้นเอกสารนี้สะท้อน actual behavior และ actual keys ที่ code ใช้อย่างตรงไปตรงมา