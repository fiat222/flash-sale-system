import { ConflictException, Inject, Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { readFileSync } from 'fs';
import { join } from 'path';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../redis/redis.provider';
import { MetricsService } from '../metrics/metrics.service';

const CLAIM_STOCK_SCRIPT = readFileSync(join(__dirname, 'lua/claim-stock.lua'), 'utf-8');

export interface OrderJobData {
  userId: string;
  productId: string;
}

@Injectable()
export class OrdersService {
  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @InjectQueue('orders') private readonly ordersQueue: Queue<OrderJobData>,
    private readonly metrics: MetricsService,
  ) {}

  async claim(userId: string, productId: string) {
    const result = (await this.redis.eval(
      CLAIM_STOCK_SCRIPT,
      2,
      `cache:claim:${productId}`,
      `cache:stock:${productId}`,
      userId,
    )) as number;

    if (result === -1) {
      this.metrics.increment('orders_duplicate');
      throw new ConflictException({ status: 'rejected', message: 'You already claimed this product' });
    }
    if (result === -2) {
      this.metrics.increment('orders_soldout');
      throw new ConflictException({ status: 'rejected', message: 'Product sold out' });
    }
    this.metrics.increment('orders_accepted');

    const job = await this.ordersQueue.add(
      'deduct',
      { userId, productId },
      {
        // BullMQ rejects ":" in custom job IDs (reserved for its own key
        // namespacing) — "|" still gives us the same deterministic dedup key.
        jobId: `${userId}|${productId}`,
        // Keep the last N terminal jobs so Bull-Board can show real
        // Completed / Failed counts for the report (spec 3, Queue Monitoring).
        removeOnComplete: { count: 1000 },
        removeOnFail: { count: 1000 },
        attempts: 3,
        backoff: { type: 'exponential', delay: 200 },
      },
    );

    return {
      status: 'processing',
      orderJobId: job.id,
      message: 'Your order is in the queue.',
    };
  }
}
