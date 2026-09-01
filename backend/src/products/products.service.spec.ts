import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Product } from '../database/entities/product.entity';
import { REDIS_CLIENT } from '../redis/redis.provider';
import { MetricsService } from '../metrics/metrics.service';
import { ProductsService, ProductPage } from './products.service';

const ROW = {
  productId: 'p-1001',
  name: 'Limited Edition Sneaker',
  price: '2990.00',
  availableStock: 50,
  remainingStock: 50,
  isFlashSaleActive: true,
};

describe('ProductsService', () => {
  let service: ProductsService;
  let store: Map<string, string>;
  let redis: {
    get: jest.Mock;
    set: jest.Mock;
    mget: jest.Mock;
    eval: jest.Mock;
    sadd: jest.Mock;
    smembers: jest.Mock;
    unlink: jest.Mock;
  };
  let repo: { find: jest.Mock; count: jest.Mock };

  beforeEach(async () => {
    store = new Map();
    const setKeys = new Set<string>();
    redis = {
      get: jest.fn((k: string) => Promise.resolve(store.has(k) ? store.get(k)! : null)),
      // Mirrors ioredis: `SET k v ... NX` returns null when the key already exists.
      set: jest.fn((k: string, v: string, ...rest: unknown[]) => {
        if (rest.includes('NX') && store.has(k)) return Promise.resolve(null);
        store.set(k, v);
        return Promise.resolve('OK');
      }),
      mget: jest.fn().mockResolvedValue([]),
      eval: jest.fn((_lua: string, _n: number, k: string) => {
        store.delete(k);
        return Promise.resolve(1);
      }),
      sadd: jest.fn((_k: string, ...members: string[]) => {
        members.forEach((m) => setKeys.add(m));
        return Promise.resolve(members.length);
      }),
      smembers: jest.fn(() => Promise.resolve([...setKeys])),
      unlink: jest.fn((...keys: string[]) => {
        keys.forEach((k) => {
          store.delete(k);
          setKeys.delete(k);
        });
        return Promise.resolve(keys.length);
      }),
    };
    repo = { find: jest.fn(), count: jest.fn().mockResolvedValue(1) };

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

  const parse = (raw: string) => JSON.parse(raw) as ProductPage;

  it('builds from Postgres on a cache miss and splices live remainingStock from Redis', async () => {
    repo.find.mockResolvedValue([{ ...ROW }]);
    redis.mget.mockResolvedValue(['30']);

    const body = parse(await service.getPageRaw(1, 10));

    expect(repo.find).toHaveBeenCalledTimes(1);
    expect(redis.mget).toHaveBeenCalledWith(['cache:stock:p-1001']);
    expect(body.data[0].remainingStock).toBe(30);
    expect(body.data[0].productId).toBe('p-1001');
    expect(body.meta).toEqual({ total: 1, page: 1, limit: 10, totalPages: 1 });

    // template (not the stock) cached under the page key with a long jittered TTL
    const pageSet = redis.set.mock.calls.find((c) => c[0] === 'cache:products:tpl:1:limit:10');
    expect(pageSet).toBeDefined();
    expect(pageSet![2]).toBe('EX');
    expect(pageSet![3]).toBeGreaterThanOrEqual(600);
    expect(pageSet![3]).toBeLessThan(660);
    // the cached blob carries no live stock value
    expect(pageSet![1]).not.toContain('"remainingStock":30');
  });

  it('falls back to the DB remainingStock when the live counter is cold', async () => {
    repo.find.mockResolvedValue([{ ...ROW, remainingStock: 42 }]);
    redis.mget.mockResolvedValue([null]);

    const body = parse(await service.getPageRaw(1, 10));

    expect(body.data[0].remainingStock).toBe(42);
  });

  it('serves a warm page without touching Postgres, re-splicing stock each read', async () => {
    repo.find.mockResolvedValue([{ ...ROW }]);

    redis.mget.mockResolvedValue(['30']);
    await service.getPageRaw(2, 10); // cold: build + cache template
    repo.find.mockClear();

    redis.mget.mockResolvedValue(['12']); // stock moved since the template was built
    const body = parse(await service.getPageRaw(2, 10)); // warm: GET + MGET splice

    expect(repo.find).not.toHaveBeenCalled();
    expect(body.data[0].remainingStock).toBe(12);
  });

  it('single-flights a stampede of concurrent misses onto one Postgres build', async () => {
    let resolveDb!: (v: unknown[]) => void;
    repo.find.mockReturnValue(new Promise((r) => (resolveDb = r)));
    redis.mget.mockResolvedValue(['30']);

    const calls = [service.getPageRaw(3, 10), service.getPageRaw(3, 10), service.getPageRaw(3, 10)];
    resolveDb([{ ...ROW }]);
    await Promise.all(calls);

    expect(repo.find).toHaveBeenCalledTimes(1); // not 3
  });

  it('L2: a waiter returns the template another instance publishes while holding the lock', async () => {
    repo.find.mockResolvedValue([{ ...ROW }]);
    redis.mget.mockResolvedValue(['7']);

    // Simulate the cross-instance lock already being held elsewhere.
    redis.set.mockImplementation((k: string, v: string, ...rest: unknown[]) => {
      if (k.startsWith('lock:') && rest.includes('NX')) return Promise.resolve(null);
      store.set(k, v);
      return Promise.resolve('OK');
    });

    const pending = service.getPageRaw(9, 10);
    // The other instance finishes and publishes the template blob for this key.
    const other = await service['buildBlob'](9, 10);
    store.set('cache:products:tpl:9:limit:10', other);

    const body = parse(await pending);
    expect(body.meta.page).toBe(9);
    // the waiter built the blob only via the simulation above, never through its
    // own getPageRaw path beyond the one internal call
    expect(repo.find).toHaveBeenCalledTimes(1);
  });

  it('invalidate() UNLINKs the tracked template keys, not a keyspace scan', async () => {
    repo.find.mockResolvedValue([{ ...ROW }]);
    redis.mget.mockResolvedValue(['30']);

    await service.getPageRaw(1, 10);
    await service.getPageRaw(2, 10);
    expect(store.has('cache:products:tpl:1:limit:10')).toBe(true);

    await service.invalidate();

    expect(redis.smembers).toHaveBeenCalledWith('cache:products:tplkeys');
    expect(redis.unlink.mock.calls[0]).toEqual(
      expect.arrayContaining([
        'cache:products:tplkeys',
        'cache:products:tpl:1:limit:10',
        'cache:products:tpl:2:limit:10',
      ]),
    );
    expect(store.has('cache:products:tpl:1:limit:10')).toBe(false);
  });
});
