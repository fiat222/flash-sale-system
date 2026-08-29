import { Inject, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import Redis from 'ioredis';
import { Product } from '../database/entities/product.entity';
import { REDIS_CLIENT } from '../redis/redis.provider';
import { MetricsService } from '../metrics/metrics.service';

interface PageTemplate {
  segments: string[];
  ids: string[];
}

// Redis keys
const K_PAGE = (key: string) => `cache:page:${key}`; // fully-rendered JSON string
const K_TEMPLATE = (key: string) => `cache:template:${key}`; // rows only, stock spliced in
const K_PAGEKEYS = 'cache:pagekeys'; // SET of every page key ever built
const K_VERSION = 'cache:ver'; // bumped on every invalidation — nginx edge cache key

@Injectable()
export class ProductsService {
  constructor(
    @InjectRepository(Product) private readonly productRepo: Repository<Product>,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly metrics: MetricsService,
  ) {}

  // Hot path: ONE Redis GET. `cache:page:{key}` holds the final response string
  // with remainingStock already baked in — no per-request JSON.parse / MGET /
  // concat. The worker keeps it fresh (rebuildPage) after every stock change,
  // so a hit is always current.
  async getPage(page: number, limit: number): Promise<string> {
    const key = `${page}:${limit}`;
    const cached = await this.redis.get(K_PAGE(key));
    if (cached !== null) {
      this.metrics.increment('cache_hit');
      return cached;
    }
    this.metrics.increment('cache_miss');
    return this.rebuildPage(key, page, limit);
  }

  // Rebuild `cache:page:{key}` from the row template + live stock. Called on a
  // cold miss (from getPage) and by the worker for every known page key after a
  // committed stock deduction. No Postgres hit unless the row template itself is
  // missing (only happens on a truly cold cache / product catalog change).
  async rebuildPage(key: string, page?: number, limit?: number): Promise<string> {
    if (page === undefined || limit === undefined) {
      const [p, l] = key.split(':');
      page = Number(p);
      limit = Number(l);
    }

    const tpl = await this.getTemplate(key, page, limit);
    let out: string;
    if (tpl.ids.length === 0) {
      out = tpl.segments[0];
    } else {
      const stocks = await this.redis.mget(tpl.ids.map((id) => `cache:stock:${id}`));
      out = tpl.segments[0];
      for (let i = 0; i < stocks.length; i++) {
        out += (stocks[i] ?? '0') + tpl.segments[i + 1];
      }
    }

    await this.redis
      .pipeline()
      .set(K_PAGE(key), out)
      .sadd(K_PAGEKEYS, key)
      .exec();
    return out;
  }

  // Invalidation = rebuild every page (so the edge/Node caches are correct
  // immediately, per spec 2.2) then bump the version the nginx edge keys off.
  // ORDER MATTERS: pages are refreshed BEFORE `cache:ver` moves, so the first
  // request on the new version can only ever read fresh page JSON.
  async invalidate(): Promise<void> {
    const keys = await this.redis.smembers(K_PAGEKEYS);
    await Promise.all(keys.map((key) => this.rebuildPage(key)));
    await this.redis.incr(K_VERSION);
  }

  // Back-compat alias — the worker used to call this.
  async invalidateTemplates(): Promise<void> {
    return this.invalidate();
  }

  private async getTemplate(key: string, page: number, limit: number): Promise<PageTemplate> {
    const raw = await this.redis.get(K_TEMPLATE(key));
    if (raw) return JSON.parse(raw) as PageTemplate;
    return this.buildTemplate(page, limit, key);
  }

  private async buildTemplate(page: number, limit: number, key: string): Promise<PageTemplate> {
    const [rows, total] = await this.productRepo.findAndCount({
      order: { productId: 'ASC' },
      skip: (page - 1) * limit,
      take: limit,
    });
    const totalPages = Math.ceil(total / limit);

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
      meta: { total, page, limit, totalPages },
    };

    const json = JSON.stringify(body);
    const ids = rows.map((r) => r.productId);
    const segments: string[] = [];
    let rest = json;
    for (let i = 0; i < ids.length; i++) {
      const marker = `"@@RS${i}@@"`;
      const idx = rest.indexOf(marker);
      segments.push(rest.slice(0, idx));
      rest = rest.slice(idx + marker.length);
    }
    segments.push(rest);

    const tpl: PageTemplate = { segments, ids };
    await this.redis.set(K_TEMPLATE(key), JSON.stringify(tpl));
    return tpl;
  }
}
