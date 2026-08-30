import { Inject, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import Redis from 'ioredis';
import { Product } from '../database/entities/product.entity';
import { REDIS_CLIENT } from '../redis/redis.provider';
import { MetricsService } from '../metrics/metrics.service';

const PAGE_KEY = (page: number, limit: number) => `cache:products:page:${page}:limit:${limit}`;
const PAGE_KEY_GLOB = 'cache:products:page:*';
const PAGE_TTL_SECONDS = 60;

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
  // Single-flight (lab 4): in-flight Postgres builds keyed by page key. Holds
  // only unsettled promises (deleted in .finally) — not a result cache.
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

    // Coalesce a stampede of concurrent requests for the same uncached page
    // onto ONE Postgres build instead of N (lab 4 cache-stampede fix).
    const pending = this.inflight.get(key);
    if (pending) return pending;

    const build = this.buildAndCache(page, limit, key).finally(() => this.inflight.delete(key));
    this.inflight.set(key, build);
    return build;
  }

  private async buildAndCache(page: number, limit: number, key: string): Promise<ProductPage> {
    this.metrics.increment('db_build'); // actual Postgres rebuilds (< cache_miss thanks to single-flight)
    const body = await this.buildPage(page, limit);
    await this.redis.set(key, JSON.stringify(body), 'EX', PAGE_TTL_SECONDS);
    return body;
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
