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

@Injectable()
export class ProductsService {
  // segments/ids never change during a flash sale (product catalog is static) —
  // safe to hold per-instance without any invalidation for L1.
  private readonly l1 = new Map<string, PageTemplate>();

  constructor(
    @InjectRepository(Product) private readonly productRepo: Repository<Product>,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly metrics: MetricsService,
  ) {}

  async getPage(page: number, limit: number): Promise<string> {
    const key = `${page}:${limit}`;
    let tpl = this.l1.get(key);
    if (tpl) {
      this.metrics.increment('cache_l1_hit');
    } else {
      const fromL2 = await this.loadFromL2(key);
      this.metrics.increment(fromL2 ? 'cache_l2_hit' : 'cache_miss');
      tpl = fromL2 ?? (await this.buildTemplate(page, limit, key));
      this.l1.set(key, tpl);
    }

    if (tpl.ids.length === 0) return tpl.segments[0];

    const stocks = await this.redis.mget(tpl.ids.map((id) => `cache:stock:${id}`));
    let out = tpl.segments[0];
    for (let i = 0; i < stocks.length; i++) {
      out += (stocks[i] ?? '0') + tpl.segments[i + 1];
    }
    return out;
  }

  // Called by the worker after a committed stock deduction, per the documented
  // cache-invalidation strategy (product fields other than remainingStock —
  // which is never cached — are cheap to fully re-derive on next request).
  async invalidateTemplates(): Promise<void> {
    this.l1.clear();
    let cursor = '0';
    do {
      const [next, keys] = await this.redis.scan(cursor, 'MATCH', 'cache:template:*', 'COUNT', 100);
      cursor = next;
      if (keys.length) await this.redis.del(...keys);
    } while (cursor !== '0');
  }

  private async loadFromL2(key: string): Promise<PageTemplate | null> {
    const raw = await this.redis.get(`cache:template:${key}`);
    return raw ? (JSON.parse(raw) as PageTemplate) : null;
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
    await this.redis.set(`cache:template:${key}`, JSON.stringify(tpl));
    return tpl;
  }
}
