import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { ValidationPipe, Logger } from '@nestjs/common';
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

  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));

  if (role === 'worker') {
    const queue = app.get<Queue>(getQueueToken('orders'));
    await mountBullBoard(app.getHttpAdapter().getInstance(), queue);
    const port = Number(process.env.WORKER_PORT ?? 3001);
    await app.listen(port, '0.0.0.0');
    logger.log(`Worker up — Bull-Board on :${port}/admin/queues`);
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
