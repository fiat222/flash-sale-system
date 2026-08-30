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
    scan: jest.Mock;
    del: jest.Mock;
    eval: jest.Mock;
  };
  let repo: { findAndCount: jest.Mock };

  beforeEach(async () => {
    store = new Map();
    redis = {
      get: jest.fn((k: string) => Promise.resolve(store.has(k) ? store.get(k) : null)),
      // Mirrors ioredis: `SET k v ... NX` returns null when the key already exists.
      set: jest.fn((k: string, v: string, ...rest: unknown[]) => {
        if (rest.includes('NX') && store.has(k)) return Promise.resolve(null);
        store.set(k, v);
        return Promise.resolve('OK');
      }),
      mget: jest.fn(),
      scan: jest.fn(),
      del: jest.fn(),
      eval: jest.fn((_lua: string, _n: number, k: string) => {
        store.delete(k);
        return Promise.resolve(1);
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

  it('builds from Postgres on a cache miss and splices live remainingStock from Redis', async () => {
    repo.findAndCount.mockResolvedValue([
      [
        {
          productId: 'p-1001',
          name: 'Limited Edition Sneaker',
          price: '2990.00',
          availableStock: 50,
          remainingStock: 50,
          isFlashSaleActive: true,
        },
      ],
      1,
    ]);
    redis.mget.mockResolvedValue(['30']);

    const body = await service.getPage(1, 10);

    expect(repo.findAndCount).toHaveBeenCalledTimes(1);
    expect(redis.mget).toHaveBeenCalledWith(['cache:stock:p-1001']);
    expect(body.data[0].remainingStock).toBe(30);
    expect(body.meta).toEqual({ total: 1, page: 1, limit: 10, totalPages: 1 });
    // cached (serialised) under the page key with a TTL
    expect(redis.set).toHaveBeenCalledWith(
      'cache:products:page:1:limit:10',
      expect.any(String),
      'EX',
      60,
    );
  });

  it('serves a warm page from one Redis GET — no Postgres', async () => {
    repo.findAndCount.mockResolvedValue([[], 0]);
    redis.mget.mockResolvedValue([]);

    await service.getPage(2, 10); // cold: build + cache
    repo.findAndCount.mockClear();
    await service.getPage(2, 10); // warm: GET hit

    expect(repo.findAndCount).not.toHaveBeenCalled();
  });

  it('single-flights a stampede of concurrent misses onto one Postgres build', async () => {
    let resolveDb!: (v: [unknown[], number]) => void;
    repo.findAndCount.mockReturnValue(new Promise((r) => (resolveDb = r)));
    redis.mget.mockResolvedValue([]);

    const calls = [service.getPage(3, 10), service.getPage(3, 10), service.getPage(3, 10)];
    resolveDb([[], 0]);
    await Promise.all(calls);

    expect(repo.findAndCount).toHaveBeenCalledTimes(1); // not 3
  });

  it('L2: a waiter returns the page another instance publishes while holding the Redis lock', async () => {
    repo.findAndCount.mockResolvedValue([[], 0]);
    redis.mget.mockResolvedValue([]);

    // Simulate the cross-instance lock already being held elsewhere.
    redis.set.mockImplementation((k: string, v: string, ...rest: unknown[]) => {
      if (k.startsWith('lock:') && rest.includes('NX')) return Promise.resolve(null);
      store.set(k, v);
      return Promise.resolve('OK');
    });

    const pending = service.getPage(9, 10);
    // The other instance finishes its build and publishes the page.
    store.set(
      'cache:products:page:9:limit:10',
      JSON.stringify({ status: 'success', data: [], meta: { total: 0, page: 9, limit: 10, totalPages: 0 } }),
    );

    const body = await pending;
    expect(body.meta.page).toBe(9);
    expect(repo.findAndCount).not.toHaveBeenCalled(); // the waiter never touched Postgres
  });

  it('invalidate() SCANs and deletes every cached product page', async () => {
    redis.scan
      .mockResolvedValueOnce(['7', ['cache:products:page:1:limit:10']])
      .mockResolvedValueOnce(['0', ['cache:products:page:2:limit:10']]);

    await service.invalidate();

    expect(redis.del).toHaveBeenCalledWith('cache:products:page:1:limit:10');
    expect(redis.del).toHaveBeenCalledWith('cache:products:page:2:limit:10');
  });
});
