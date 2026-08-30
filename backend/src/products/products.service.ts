import { Inject, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { randomUUID } from 'crypto';
import Redis from 'ioredis';
import { Product } from '../database/entities/product.entity';
import { REDIS_CLIENT } from '../redis/redis.provider';
import { MetricsService } from '../metrics/metrics.service';

const TPL_KEY = (page: number, limit: number) => `cache:products:tpl:${page}:limit:${limit}`;
// Every live template key is tracked in this set so invalidate() can UNLINK the
// exact list instead of scanning the keyspace (the read Redis is also serving
// ~1000 VU — a SCAN per master-data write is a real cost there).
const TPLKEYS_SET = 'cache:products:tplkeys';

// TTL with jitter (anti-avalanche). Templates are all first built inside the
// same ~1s cold window, so a fixed TTL makes them expire in lockstep — one
// synchronised wave of misses. Spreading expiry over a band breaks the wave.
// The template holds NO stock (spliced live per read), so it never goes stale
// on a stock change; TTL can be long.
const PAGE_TTL_BASE_SECONDS = 600;
const PAGE_TTL_JITTER_SECONDS = 60;
const pageTtl = () => PAGE_TTL_BASE_SECONDS + Math.floor(Math.random() * PAGE_TTL_JITTER_SECONDS);

// Cross-instance single-flight (L2). Nginx round-robins cold reads across every
// api instance, so an in-process Map alone still lets one Postgres build run per
// instance. A short Redis mutex collapses that to one build per key, cluster-wide.
const LOCK_KEY = (pageKey: string) => `lock:${pageKey}`;
const LOCK_TTL_MS = 5000; // longer than the worst-case page build; auto-expires if a holder dies
const WAIT_STEP_MS = 40; // how often a waiter re-checks the cache
const WAIT_MAX_MS = 3000; // after this a waiter stops waiting and builds uncached, to stay responsive
// Release only if the lock is still ours (compare-and-delete) so a slow builder
// can't wipe a lock a later request already re-acquired.
const RELEASE_LUA = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

// Framing for the cached template blob. NUL / SOH never appear literally in
// valid JSON text, so we can split the blob back into its parts with plain
// String.split — no JSON.parse on the read hot path.
const FIELD_SEP = '\x01'; // between the three sections
const ITEM_SEP = '\x00'; // between items within a section
// Placeholder that stands in for each remainingStock value while the template
// JSON is serialised, then split out so the live number can be spliced in.
const MARK = (i: number) => `"@@RS${i}@@"`;

export interface ProductListItem {
  productId: string;
  name: string;
  price: number;
  availableStock: number;
  remainingStock: number;
  isFlashSaleActive: boolean;
}

export interface ProductPage {
  status: 'success';
  data: ProductListItem[];
  meta: { total: number; page: number; limit: number; totalPages: number };
}

@Injectable()
export class ProductsService {
  // L1 single-flight (lab 4): in-flight template builds keyed by page key,
  // scoped to THIS process. Holds only unsettled promises (deleted in .finally)
  // — not a result cache. Each caller renders its own live-stock splice off the
  // shared blob.
  private readonly inflight = new Map<string, Promise<string>>();

  // Row count is fixed for the whole load test (seed is immutable during a run),
  // so resolve it once instead of a COUNT on every rebuild. A scalar, not a
  // cached response body.
  private totalCache?: number;

  constructor(
    @InjectRepository(Product) private readonly productRepo: Repository<Product>,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly metrics: MetricsService,
  ) {}

  // Cache-aside (lab 4): check Redis for the page template; on a miss build it
  // from Postgres, cache it with a TTL, then splice in the live remainingStock.
  // Returns the finished JSON response as a string — no JSON.parse / re-serialise
  // on the hot path.
  async getPageRaw(page: number, limit: number): Promise<string> {
    const key = TPL_KEY(page, limit);
    const cached = await this.redis.get(key);
    if (cached !== null) {
      this.metrics.increment('cache_hit');
      return this.render(cached);
    }
    this.metrics.increment('cache_miss');

    // L1: coalesce concurrent misses in this process onto one build.
    let build = this.inflight.get(key);
    if (!build) {
      build = this.buildCoalesced(page, limit, key).finally(() => this.inflight.delete(key));
      this.inflight.set(key, build);
    }
    return this.render(await build);
  }

  // L2: one Postgres build per key across every api instance. The lock winner
  // builds + publishes the template blob; everyone else polls until it appears.
  private async buildCoalesced(page: number, limit: number, key: string): Promise<string> {
    const lockKey = LOCK_KEY(key);
    const token = randomUUID();

    if ((await this.redis.set(lockKey, token, 'PX', LOCK_TTL_MS, 'NX')) === 'OK') {
      try {
        return await this.buildAndCache(page, limit, key);
      } finally {
        await this.releaseLock(lockKey, token);
      }
    }

    // Another instance is building. Wait for it to publish the template.
    const deadline = Date.now() + WAIT_MAX_MS;
    while (Date.now() < deadline) {
      await this.sleep(WAIT_STEP_MS);
      const filled = await this.redis.get(key);
      if (filled !== null) {
        this.metrics.increment('cache_wait_hit');
        return filled;
      }
      // Holder vanished (crash / TTL lapse) without publishing — try to take over.
      if ((await this.redis.set(lockKey, token, 'PX', LOCK_TTL_MS, 'NX')) === 'OK') {
        try {
          return await this.buildAndCache(page, limit, key);
        } finally {
          await this.releaseLock(lockKey, token);
        }
      }
    }

    // Gave up waiting — build without caching so this request still returns.
    this.metrics.increment('cache_wait_timeout');
    return this.buildBlob(page, limit);
  }

  private async buildAndCache(page: number, limit: number, key: string): Promise<string> {
    this.metrics.increment('db_build'); // true Postgres rebuilds (<< cache_miss thanks to L1 + L2 single-flight)
    const blob = await this.buildBlob(page, limit);
    await this.redis.set(key, blob, 'EX', pageTtl());
    await this.redis.sadd(TPLKEYS_SET, key);
    return blob;
  }

  private async releaseLock(lockKey: string, token: string): Promise<void> {
    try {
      await this.redis.eval(RELEASE_LUA, 1, lockKey, token);
    } catch {
      // The lock's PX TTL will clear it; nothing else to do.
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // Invalidate-after-write (lab 4): drop every cached product page so the next
  // read rebuilds. Only master data (name / price / flags) needs this — a stock
  // deduction can't stale a template because remainingStock is never cached, it
  // is spliced live from `cache:stock:*` on every read. UNLINK the tracked key
  // set rather than SCAN the keyspace.
  async invalidate(): Promise<void> {
    const keys = await this.redis.smembers(TPLKEYS_SET);
    await this.redis.unlink(TPLKEYS_SET, ...keys);
  }

  private async total(): Promise<number> {
    if (this.totalCache === undefined) {
      this.totalCache = await this.productRepo.count();
    }
    return this.totalCache;
  }

  // Build the template blob: the full JSON response with each remainingStock
  // replaced by a split point, plus the id list and a DB-value fallback for a
  // cold `cache:stock:*`. Layout:
  //   ids ITEM_SEP-joined  FIELD_SEP  dbStock ITEM_SEP-joined  FIELD_SEP  segments ITEM_SEP-joined
  private async buildBlob(page: number, limit: number): Promise<string> {
    const rows = await this.productRepo.find({
      order: { productId: 'ASC' },
      skip: (page - 1) * limit,
      take: limit,
    });
    const total = await this.total();

    const body = {
      status: 'success',
      data: rows.map((r, i) => ({
        productId: r.productId,
        name: r.name,
        price: Number(r.price),
        availableStock: r.availableStock,
        remainingStock: `@@RS${i}@@`,
        isFlashSaleActive: r.isFlashSaleActive,
      })),
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };

    let json = JSON.stringify(body);
    const segments: string[] = [];
    for (let i = 0; i < rows.length; i++) {
      const needle = MARK(i);
      const at = json.indexOf(needle);
      segments.push(json.slice(0, at));
      json = json.slice(at + needle.length);
    }
    segments.push(json);

    const ids = rows.map((r) => r.productId);
    const dbStock = rows.map((r) => String(r.remainingStock));
    return [ids.join(ITEM_SEP), dbStock.join(ITEM_SEP), segments.join(ITEM_SEP)].join(FIELD_SEP);
  }

  // Splice the live remainingStock into a cached template blob. One MGET, one
  // string concat — no JSON.parse, no object graph.
  private async render(blob: string): Promise<string> {
    const s1 = blob.indexOf(FIELD_SEP);
    const s2 = blob.indexOf(FIELD_SEP, s1 + 1);
    const idsPart = blob.slice(0, s1);
    const segPart = blob.slice(s2 + 1);
    if (idsPart === '') return segPart; // empty page — no stock markers

    const ids = idsPart.split(ITEM_SEP);
    const dbStock = blob.slice(s1 + 1, s2).split(ITEM_SEP);
    const segments = segPart.split(ITEM_SEP);

    const stocks = await this.redis.mget(ids.map((id) => `cache:stock:${id}`));
    let out = segments[0];
    for (let i = 0; i < ids.length; i++) {
      out += (stocks[i] != null ? stocks[i] : dbStock[i]) + segments[i + 1];
    }
    return out;
  }
}
