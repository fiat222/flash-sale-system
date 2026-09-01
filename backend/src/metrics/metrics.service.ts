import { Inject, Injectable } from '@nestjs/common';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../redis/redis.provider';

// Fixed set of counters — every metric the app emits. snapshot() MGETs these
// directly instead of `KEYS cache:m:*`, which blocks Redis' single thread and
// runs against the same instance serving the load test.
const METRIC_KEYS = [
  'cache_hit',
  'cache_miss',
  'cache_wait_hit',
  'cache_wait_timeout',
  'db_build',
  'orders_accepted',
  'orders_duplicate',
  'orders_soldout',
  'orders_completed',
  'orders_failed',
] as const;

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
    const values = await this.redis.mget(METRIC_KEYS.map((k) => `cache:m:${k}`));
    const out: Record<string, number> = {};
    METRIC_KEYS.forEach((k, i) => {
      out[k] = Number(values[i] ?? 0);
    });
    return out;
  }

  // Worker liveness for the dashboard/report (Queue Monitoring: "worker
  // status"). The worker refreshes this key every 2s with a 5s TTL, so a
  // missing key means it's down or hasn't started yet.
  async workerStatus(): Promise<'up' | 'down'> {
    return (await this.redis.exists('worker:heartbeat')) ? 'up' : 'down';
  }

  // Live remaining stock per product, for the dashboard. SCAN (cursor, non-
  // blocking) rather than KEYS so a dashboard poll can't stall the event loop
  // of the Redis under test.
  async stockSnapshot(): Promise<Record<string, number>> {
    const stock: Record<string, number> = {};
    let cursor = '0';
    do {
      const [next, keys] = await this.redis.scan(cursor, 'MATCH', 'cache:stock:*', 'COUNT', 100);
      cursor = next;
      if (keys.length) {
        const values = await this.redis.mget(keys);
        keys.forEach((k, i) => {
          stock[k.replace('cache:stock:', '')] = Number(values[i] ?? 0);
        });
      }
    } while (cursor !== '0');
    return stock;
  }
}
