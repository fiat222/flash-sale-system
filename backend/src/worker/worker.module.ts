import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { OrderProcessor } from './order.processor';

@Module({
  imports: [BullModule.registerQueue({ name: 'orders' })],
  providers: [OrderProcessor],
  exports: [BullModule],
})
export class WorkerModule {}
