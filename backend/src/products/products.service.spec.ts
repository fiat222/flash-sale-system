import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Product } from '../database/entities/product.entity';
import { REDIS_CLIENT } from '../redis/redis.provider';
import { MetricsService } from '../metrics/metrics.service';
import { ProductsService } from './products.service';

describe('ProductsService', () => {
  let service: ProductsService;
  let redis: { get: jest.Mock; set: jest.Mock; mget: jest.Mock };
  let repo: { findAndCount: jest.Mock };

  beforeEach(async () => {
    redis = { get: jest.fn().mockResolvedValue(null), set: jest.fn(), mget: jest.fn() };
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

  it('builds a template from Postgres on cold cache, then reads remainingStock live from Redis', async () => {
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

  it('never touches Postgres again once the template is cached in Redis', async () => {
    repo.findAndCount.mockResolvedValue([[], 0]);
    redis.mget.mockResolvedValue([]);
    // First call: cache miss -> build + redis.set. Make the second redis.get
    // return whatever was just stored (Redis-only Cache-Aside, no in-process cache).
    redis.set.mockImplementation((_key: string, value: string) => {
      redis.get.mockResolvedValue(value);
      return Promise.resolve('OK');
    });

    await service.getPage(2, 10);
    await service.getPage(2, 10);

    expect(repo.findAndCount).toHaveBeenCalledTimes(1);
  });
});
