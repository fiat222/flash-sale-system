import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Product } from '../database/entities/product.entity';
import { REDIS_CLIENT } from '../redis/redis.provider';
import { MetricsService } from '../metrics/metrics.service';
import { ProductsService } from './products.service';

describe('ProductsService', () => {
  let service: ProductsService;
  let store: Map<string, string>;
  let redis: {
    get: jest.Mock;
    set: jest.Mock;
    mget: jest.Mock;
    incr: jest.Mock;
    smembers: jest.Mock;
    sadd: jest.Mock;
    del: jest.Mock;
    pipeline: jest.Mock;
  };
  let repo: { findAndCount: jest.Mock };

  beforeEach(async () => {
    store = new Map();
    redis = {
      get: jest.fn((k: string) => Promise.resolve(store.has(k) ? store.get(k) : null)),
      set: jest.fn((k: string, v: string) => {
        store.set(k, v);
        return Promise.resolve('OK');
      }),
      mget: jest.fn(),
      incr: jest.fn().mockResolvedValue(1),
      smembers: jest.fn().mockResolvedValue([]),
      sadd: jest.fn(),
      del: jest.fn().mockResolvedValue(1),
      // pipeline().set().sadd().exec() — writes straight through to the store
      pipeline: jest.fn(() => {
        const p: Record<string, (...a: unknown[]) => unknown> = {
          set: (k: string, v: string) => {
            store.set(k, v);
            return p;
          },
          sadd: () => p,
          exec: () => Promise.resolve([]),
        };
        return p;
      }),
    };
    repo = { findAndCount: jest.fn() };

    const module = await Test.createTestingModule({
      providers: [
        ProductsService,
        { provide: getRepositoryToken(Product), useValue: repo },
        { provide: REDIS_CLIENT, useValue: redis },
        { provide: MetricsService, useValue: { increment: jest.fn() } },
      ],
    }).compile();

    service = module.get(ProductsService);
  });

  it('builds from Postgres on cold cache, then splices remainingStock live from Redis', async () => {
    repo.findAndCount.mockResolvedValue([
      [
        {
          productId: 'p-1001',
          name: 'Limited Edition Sneaker',
          price: '2990.00',
          availableStock: 50,
          isFlashSaleActive: true,
        },
      ],
      1,
    ]);
    redis.mget.mockResolvedValue(['30']);

    const body = JSON.parse(await service.getPage(1, 10));

    expect(repo.findAndCount).toHaveBeenCalledTimes(1);
    expect(redis.mget).toHaveBeenCalledWith(['cache:stock:p-1001']);
    expect(body.data[0].remainingStock).toBe(30);
    expect(body.meta).toEqual({ total: 1, page: 1, limit: 10, totalPages: 1 });
  });

  it('serves a warm page from one Redis GET — no Postgres, no MGET', async () => {
    repo.findAndCount.mockResolvedValue([[], 0]);
    redis.mget.mockResolvedValue([]);

    await service.getPage(2, 10); // cold: build + store cache:page:2:10
    redis.mget.mockClear();
    await service.getPage(2, 10); // warm: single GET hit

    expect(repo.findAndCount).toHaveBeenCalledTimes(1);
    expect(redis.mget).not.toHaveBeenCalled();
  });

  it('invalidate() drops every known page cache then bumps the version key', async () => {
    redis.smembers.mockResolvedValue(['1:10', '2:10']);
    store.set('cache:page:1:10', 'stale');
    store.set('cache:page:2:10', 'stale');

    await service.invalidate();

    expect(redis.del).toHaveBeenCalledWith('cache:page:1:10', 'cache:page:2:10');
    expect(redis.incr).toHaveBeenCalledWith('cache:ver');
  });
});
