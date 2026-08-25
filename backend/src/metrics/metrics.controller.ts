import { Controller, Get } from '@nestjs/common';
import { MetricsService } from './metrics.service';

@Controller('api/v1')
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  @Get('_metrics')
  async get() {
    return { status: 'success', metrics: await this.metrics.snapshot() };
  }
}
