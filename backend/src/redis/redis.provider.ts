import { Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { readFileSync } from 'fs';
import { join } from 'path';

export const REDIS_CLIENT = 'REDIS_CLIENT';

const CLAIM_STOCK_SCRIPT = readFileSync(
  join(__dirname, '../orders/lua/claim-stock.lua'),
  'utf-8',
);

export const redisProvider: Provider = {
  provide: REDIS_CLIENT,
  inject: [ConfigService],
  useFactory: (config: ConfigService) => {
    const client = new Redis({
      host: config.get<string>('REDIS_HOST', 'localhost'),
      port: config.get<number>('REDIS_PORT', 6379),
      enableAutoPipelining: true,
      maxRetriesPerRequest: 3,
      connectTimeout: 2000,
    });

    client.defineCommand('claimStock', {
      numberOfKeys: 2,
      lua: CLAIM_STOCK_SCRIPT,
    });

    return client;
  },
};

