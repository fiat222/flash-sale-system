import { Inject, Injectable } from '@nestjs/common';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../redis/redis.provider';

@Injectable()
export class MetricsService {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  // Atomic counter (lab 4): INCR is atomic on Redis' single-threaded loop, and
  // the ioredis client auto-pipelines these so a burst of increments costs one
  // round trip, not one per call. Fire-and-forget — a lost metric tick must
  // never fail or slow a request.
  increment(key: string, by = 1): void {
    void this.redis.incrby(`cache:m:${key}`, by).catch(() => undefined);
  }

  async snapshot(): Promise<Record<string, number>> {
    const keys = await this.redis.keys('cache:m:*');
    if (!keys.length) return {};
    const values = await this.redis.mget(keys);
    const out: Record<string, number> = {};
    keys.forEach((k, i) => {
      out[k.replace('cache:m:', '')] = Number(values[i] ?? 0);
    });
    return out;
  }

  // Live remaining stock per product, for the dashboard.
  async stockSnapshot(): Promise<Record<string, number>> {
    const keys = await this.redis.keys('cache:stock:*');
    const values = keys.length ? await this.redis.mget(keys) : [];
    const stock: Record<string, number> = {};
    keys.forEach((k, i) => {
      stock[k.replace('cache:stock:', '')] = Number(values[i] ?? 0);
    });
    return stock;
  }
}
