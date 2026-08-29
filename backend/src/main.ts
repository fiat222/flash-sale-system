import 'reflect-metadata';
import { unlinkSync, chmodSync } from 'fs';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { Logger } from '@nestjs/common';
import { getQueueToken } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { AppModule } from './app.module';
import { mountBullBoard } from './worker/bull-board.setup';
import { AppDataSource } from './database/data-source';
import { seed } from './database/seed';

const role = process.env.ROLE ?? 'api';
const logger = new Logger('Bootstrap');

async function runMigrate(): Promise<void> {
  await AppDataSource.initialize();
  await AppDataSource.runMigrations();
  await seed();
  await AppDataSource.destroy();
  logger.log('Migration + seed complete.');
}

async function bootstrapHttp(): Promise<void> {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    // No per-request logging on the hot path — the load test drives thousands
    // of req/s and Nest already logs bootstrap/errors separately.
    new FastifyAdapter({ logger: false, disableRequestLogging: true }),
  );

  // ValidationPipe is NOT global — it is applied only where a DTO exists
  // (OrdersController). Keeping it off GET /api/v1/products, the read hot path,
  // removes a per-request pipe pass from the endpoint the load test hammers.

  if (role === 'worker') {
    const queue = app.get<Queue>(getQueueToken('orders'));
    await mountBullBoard(app.getHttpAdapter().getInstance(), queue);
    const port = Number(process.env.WORKER_PORT ?? 3001);
    await app.listen(port, '0.0.0.0');
    logger.log(`Worker up — Bull-Board on :${port}/admin/queues`);
    return;
  }

  // nginx <-> api over a unix domain socket when API_SOCKET is set (prod
  // compose): removes the loopback-TCP syscall/softirq cost that showed up as
  // ~30% system CPU under the 1,000-VU read load. Falls back to TCP for dev.
  const socketPath = process.env.API_SOCKET;
  if (socketPath) {
    await app.init();
    const fastify = app.getHttpAdapter().getInstance();
    try {
      unlinkSync(socketPath);
    } catch {
      /* no stale socket */
    }
    await fastify.listen({ path: socketPath });
    try {
      chmodSync(socketPath, 0o777); // nginx runs as a different user
    } catch {
      /* best effort */
    }
    logger.log(`API up on ${socketPath}`);
    return;
  }

  const port = Number(process.env.API_PORT ?? 3000);
  await app.listen(port, '0.0.0.0');
  logger.log(`API up on :${port}`);
}

async function bootstrap(): Promise<void> {
  if (role === 'migrate') {
    await runMigrate();
    process.exit(0);
  }
  await bootstrapHttp();
}

bootstrap().catch((err) => {
  logger.error(err);
  process.exit(1);
});
