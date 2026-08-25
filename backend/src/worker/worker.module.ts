import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ProductsModule } from '../products/products.module';
import { OrderProcessor } from './order.processor';

@Module({
  imports: [BullModule.registerQueue({ name: 'orders' }), ProductsModule],
  providers: [OrderProcessor],
  exports: [BullModule],
})
export class WorkerModule {}
