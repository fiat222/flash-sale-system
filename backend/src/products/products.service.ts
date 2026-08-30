import { Inject, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { randomUUID } from 'crypto';
import Redis from 'ioredis';
import { Product } from '../database/entities/product.entity';
import { REDIS_CLIENT } from '../redis/redis.provider';
import { MetricsService } from '../metrics/metrics.service';

const PAGE_KEY = (page: number, limit: number) => `cache:products:page:${page}:limit:${limit}`;
const PAGE_KEY_GLOB = 'cache:products:page:*';
const PAGE_TTL_SECONDS = 60;

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
  // L1 single-flight (lab 4): in-flight Postgres builds keyed by page key,
  // scoped to THIS process. Holds only unsettled promises (deleted in .finally)
  // — not a result cache.
  private readonly inflight = new Map<string, Promise<ProductPage>>();

  constructor(
    @InjectRepository(Product) private readonly productRepo: Repository<Product>,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly metrics: MetricsService,
  ) {}

  // Cache-aside (lab 4): check Redis; on a miss build the page from Postgres +
  // live stock, cache the serialised payload with a TTL, and return it.
  async getPage(page: number, limit: number): Promise<ProductPage> {
    const key = PAGE_KEY(page, limit);
    const cached = await this.redis.get(key);
    if (cached !== null) {
      this.metrics.increment('cache_hit');
      return JSON.parse(cached) as ProductPage;
    }
    this.metrics.increment('cache_miss');

    // L1: coalesce concurrent misses in this process onto one build.
    const pending = this.inflight.get(key);
    if (pending) return pending;

    const build = this.buildCoalesced(page, limit, key).finally(() => this.inflight.delete(key));
    this.inflight.set(key, build);
    return build;
  }

  // L2: one Postgres build per key across every api instance. The lock winner
  // builds + publishes; everyone else polls the cache until it appears.
  private async buildCoalesced(page: number, limit: number, key: string): Promise<ProductPage> {
    const lockKey = LOCK_KEY(key);
    const token = randomUUID();

    if ((await this.redis.set(lockKey, token, 'PX', LOCK_TTL_MS, 'NX')) === 'OK') {
      try {
        return await this.buildAndCache(page, limit, key);
      } finally {
        await this.releaseLock(lockKey, token);
      }
    }

    // Another instance is building. Wait for it to publish the page.
    const deadline = Date.now() + WAIT_MAX_MS;
    while (Date.now() < deadline) {
      await this.sleep(WAIT_STEP_MS);
      const filled = await this.redis.get(key);
      if (filled !== null) {
        this.metrics.increment('cache_wait_hit');
        return JSON.parse(filled) as ProductPage;
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
    return this.buildPage(page, limit);
  }

  private async buildAndCache(page: number, limit: number, key: string): Promise<ProductPage> {
    this.metrics.increment('db_build'); // true Postgres rebuilds (<< cache_miss thanks to L1 + L2 single-flight)
    const body = await this.buildPage(page, limit);
    await this.redis.set(key, JSON.stringify(body), 'EX', PAGE_TTL_SECONDS);
    return body;
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

  // Invalidate-after-write (lab 4): the worker calls this AFTER a committed
  // stock deduction. Drop every cached product page so the next read rebuilds
  // with the current remainingStock.
  async invalidate(): Promise<void> {
    let cursor = '0';
    do {
      const [next, keys] = await this.redis.scan(cursor, 'MATCH', PAGE_KEY_GLOB, 'COUNT', 100);
      cursor = next;
      if (keys.length) await this.redis.del(...keys);
    } while (cursor !== '0');
  }

  private async buildPage(page: number, limit: number): Promise<ProductPage> {
    const [rows, total] = await this.productRepo.findAndCount({
      order: { productId: 'ASC' },
      skip: (page - 1) * limit,
      take: limit,
    });

    // remainingStock lives in Redis (`cache:stock:*`), decremented atomically by
    // the order claim. Read it live so the list is right the moment a claim
    // lands — the DB column only catches up once the worker commits. Fall back
    // to the DB value if the counter is missing (cold cache).
    const stocks = rows.length
      ? await this.redis.mget(rows.map((r) => `cache:stock:${r.productId}`))
      : [];

    return {
      status: 'success',
      data: rows.map((r, i) => ({
        productId: r.productId,
        name: r.name,
        price: Number(r.price),
        availableStock: r.availableStock,
        remainingStock: stocks[i] != null ? Number(stocks[i]) : r.remainingStock,
        isFlashSaleActive: r.isFlashSaleActive,
      })),
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }
}
