import { Controller, Get, Header } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { MetricsService } from './metrics.service';
import { DASHBOARD_HTML } from './dashboard.html';

@Controller('api/v1')
export class MetricsController {
  constructor(
    private readonly metrics: MetricsService,
    @InjectQueue('orders') private readonly ordersQueue: Queue,
  ) {}

  @Get('_metrics')
  async get() {
    const [metrics, counts, stock] = await Promise.all([
      this.metrics.snapshot(),
      this.ordersQueue.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed'),
      this.metrics.stockSnapshot(),
    ]);

    // `queue.completed` is capped by removeOnComplete; the authoritative
    // lifetime totals are the orders_completed / orders_failed counters in
    // `metrics`, emitted by the worker on every terminal job.
    return { status: 'success', metrics, queue: counts, stock };
  }

  // Zero-dependency live dashboard — same origin as /_metrics so no CORS.
  //   http://<host>/api/v1/_dashboard
  @Get('_dashboard')
  @Header('content-type', 'text/html; charset=utf-8')
  dashboard(): string {
    return DASHBOARD_HTML;
  }
}
