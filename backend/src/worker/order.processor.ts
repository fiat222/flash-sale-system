import { Inject, Logger } from '@nestjs/common';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Job, UnrecoverableError } from 'bullmq';
import { DataSource } from 'typeorm';
import Redis from 'ioredis';
import { Product } from '../database/entities/product.entity';
import { Order } from '../database/entities/order.entity';
import { REDIS_CLIENT } from '../redis/redis.provider';
import { ProductsService } from '../products/products.service';
import { MetricsService } from '../metrics/metrics.service';
import { OrderJobData } from '../orders/orders.service';

@Processor('orders', { concurrency: Number(process.env.WORKER_CONCURRENCY ?? 15) })
export class OrderProcessor extends WorkerHost {
  private readonly logger = new Logger(OrderProcessor.name);

  constructor(
    private readonly dataSource: DataSource,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly productsService: ProductsService,
    private readonly metrics: MetricsService,
  ) {
    super();
  }

  // Lifetime queue totals for the report (spec 3, Queue Monitoring). Bull-Board
  // shows only the last N jobs (removeOnComplete/Fail); these counters don't
  // decay.
  @OnWorkerEvent('completed')
  onCompleted(): void {
    this.metrics.increment('orders_completed');
  }

  async process(job: Job<OrderJobData>): Promise<void> {
    const { userId, productId } = job.data;

    try {
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
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === '23505') {
        throw new UnrecoverableError('duplicate order');
      }
      throw err;
    }

    await this.productsService.invalidate();
  }

  // Compensation: only for jobs that exhausted retries on a transient failure.
  // Unrecoverable failures (duplicate / sold-out) mean the reservation is
  // final — reversing them would let Redis stock drift above what's real.
  @OnWorkerEvent('failed')
  async onFailed(job: Job<OrderJobData> | undefined, err: Error): Promise<void> {
    if (!job) return;
    const attemptsExhausted = job.attemptsMade >= (job.opts.attempts ?? 1);
    const terminal = attemptsExhausted || err instanceof UnrecoverableError;
    if (terminal) this.metrics.increment('orders_failed');

    // Compensation only for a transient failure that ran out of retries;
    // unrecoverable ones (duplicate / sold-out) are final.
    if (!attemptsExhausted || err instanceof UnrecoverableError) return;

    const { userId, productId } = job.data;
    await this.redis.incr(`cache:stock:${productId}`);
    await this.redis.srem(`cache:claim:${productId}`, userId);
    this.logger.warn(`Compensated stock for ${userId}:${productId} after exhausted retries`);
  }
}
