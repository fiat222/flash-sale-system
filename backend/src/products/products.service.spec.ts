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

  it('builds a template from Postgres on an L1/L2 miss and reads live stock with one MGET', async () => {
    repo.findAndCount.mockResolvedValue([
      [
        {
          productId: 'p-1001',
          name: 'Limited Edition Sneaker',
          price: '2990.00',
          availableStock: 50,
          isFlashSaleActive: true,
        },
        {
          productId: 'p-1002',
          name: 'Gaming Mouse',
          price: '4590.00',
          availableStock: 20,
          isFlashSaleActive: false,
        },
      ],
      11,
    ]);
    redis.mget.mockResolvedValue(['30', '12']);

    const body = JSON.parse(await service.getPage(1, 10));

    expect(redis.get).toHaveBeenCalledWith('cache:template:1:10');
    expect(repo.findAndCount).toHaveBeenCalledWith({
      order: { productId: 'ASC' },
      skip: 0,
      take: 10,
    });
    expect(redis.set).toHaveBeenCalledWith('cache:template:1:10', expect.any(String));
    expect(redis.mget).toHaveBeenCalledTimes(1);
    expect(redis.mget).toHaveBeenCalledWith(['cache:stock:p-1001', 'cache:stock:p-1002']);
    expect(body.data).toEqual([
      {
        productId: 'p-1001',
        name: 'Limited Edition Sneaker',
        price: 2990,
        availableStock: 50,
        remainingStock: 30,
        isFlashSaleActive: true,
      },
      {
        productId: 'p-1002',
        name: 'Gaming Mouse',
        price: 4590,
        availableStock: 20,
        remainingStock: 12,
        isFlashSaleActive: false,
      },
    ]);
    expect(body.meta).toEqual({ total: 11, page: 1, limit: 10, totalPages: 2 });
  });

  it('uses the L2 template without querying Postgres', async () => {
    redis.get.mockResolvedValue(
      JSON.stringify({
        segments: [
          '{"status":"success","data":[{"productId":"p-1001","name":"Product 1","price":99.5,"availableStock":7,"remainingStock":',
          '}],"meta":{"total":1,"page":1,"limit":10,"totalPages":1}}',
        ],
        ids: ['p-1001'],
      }),
    );
    redis.mget.mockResolvedValue(['6']);

    const body = JSON.parse(await service.getPage(1, 10));

    expect(redis.get).toHaveBeenCalledWith('cache:template:1:10');
    expect(repo.findAndCount).not.toHaveBeenCalled();
    expect(redis.mget).toHaveBeenCalledTimes(1);
    expect(body.data[0]).toEqual({
      productId: 'p-1001',
      name: 'Product 1',
      price: 99.5,
      availableStock: 7,
      remainingStock: 6,
    });
  });

  it('uses L1 after warm-up without reading L2 or querying Postgres', async () => {
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

    await service.getPage(2, 10);
    redis.get.mockClear();
    repo.findAndCount.mockClear();
    redis.mget.mockClear();
    await service.getPage(2, 10);

    expect(redis.get).not.toHaveBeenCalled();
    expect(repo.findAndCount).not.toHaveBeenCalled();
    expect(redis.mget).toHaveBeenCalledTimes(1);
    expect(redis.mget).toHaveBeenCalledWith(['cache:stock:p-1001']);
  });

  it('returns an empty page with correct meta without calling MGET', async () => {
    repo.findAndCount.mockResolvedValue([[], 20]);

    const body = JSON.parse(await service.getPage(3, 10));

    expect(body).toEqual({
      status: 'success',
      data: [],
      meta: { total: 20, page: 3, limit: 10, totalPages: 2 },
    });
    expect(redis.mget).not.toHaveBeenCalled();
  });
});
