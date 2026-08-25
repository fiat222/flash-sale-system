import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bullmq';
import { Product } from './database/entities/product.entity';
import { Order } from './database/entities/order.entity';
import { RedisModule } from './redis/redis.module';
import { MetricsModule } from './metrics/metrics.module';
import { AuthModule } from './auth/auth.module';
import { ProductsModule } from './products/products.module';
import { OrdersModule } from './orders/orders.module';
import { WorkerModule } from './worker/worker.module';

const role = process.env.ROLE ?? 'api';

// Same image for every role — only the module list changes. Keeps the worker
// process free of HTTP-facing controllers it has no business serving.
const roleModules = role === 'worker' ? [WorkerModule] : [AuthModule, ProductsModule, OrdersModule];

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'postgres' as const,
        host: config.get<string>('POSTGRES_HOST', 'localhost'),
        port: config.get<number>('POSTGRES_PORT', 5432),
        database: config.get<string>('POSTGRES_DB', 'flash_sale'),
        username: config.get<string>('POSTGRES_USER', 'flash_sale'),
        password: config.get<string>('POSTGRES_PASSWORD', 'changeme'),
        entities: [Product, Order],
        synchronize: false,
        extra: {
          max: role === 'worker'
            ? config.get<number>('POSTGRES_POOL_WORKER', 10)
            : config.get<number>('POSTGRES_POOL_API', 5),
        },
      }),
    }),
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        connection: {
          host: config.get<string>('REDIS_HOST', 'localhost'),
          port: config.get<number>('REDIS_PORT', 6379),
        },
      }),
    }),
    RedisModule,
    MetricsModule,
    ...roleModules,
  ],
})
export class AppModule {}
