import { Controller, Get } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { MetricsService } from './metrics.service';

@Controller('api/v1')
export class MetricsController {
  constructor(
    private readonly metrics: MetricsService,
    @InjectQueue('orders') private readonly ordersQueue: Queue,
  ) {}

  @Get('_metrics')
  async get() {
    const [metrics, counts] = await Promise.all([
      this.metrics.snapshot(),
      this.ordersQueue.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed'),
    ]);

    // `queue.completed` is capped by removeOnComplete; the authoritative
    // lifetime totals are the orders_completed / orders_failed counters in
    // `metrics`, emitted by the worker on every terminal job.
    return { status: 'success', metrics, queue: counts };
  }
}
