import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../redis/redis.provider';

const FLUSH_INTERVAL_MS = 1000;

@Injectable()
export class MetricsService implements OnModuleInit, OnModuleDestroy {
  private counters: Record<string, number> = {};
  private timer?: NodeJS.Timeout;

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  onModuleInit(): void {
    // Count in memory, flush to Redis once a second — avoids an extra Redis
    // round trip on every single request just to bump a counter.
    this.timer = setInterval(() => void this.flush(), FLUSH_INTERVAL_MS);
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
  }

  increment(key: string, by = 1): void {
    this.counters[key] = (this.counters[key] ?? 0) + by;
  }

  private async flush(): Promise<void> {
    const entries = Object.entries(this.counters);
    if (!entries.length) return;
    this.counters = {};
    const pipeline = this.redis.pipeline();
    for (const [key, value] of entries) pipeline.incrby(`cache:m:${key}`, value);
    await pipeline.exec();
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
}
