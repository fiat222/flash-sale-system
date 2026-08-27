import { Global, Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { MetricsController } from './metrics.controller';
import { MetricsService } from './metrics.service';

@Global()
@Module({
  // Registered here too so GET /api/v1/_metrics can report live queue depth
  // (waiting/active) alongside the counters.
  imports: [BullModule.registerQueue({ name: 'orders' })],
  controllers: [MetricsController],
  providers: [MetricsService],
  exports: [MetricsService],
})
export class MetricsModule {}
