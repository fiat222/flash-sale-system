import { ConflictException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import { REDIS_CLIENT } from '../redis/redis.provider';
import { OrdersService } from './orders.service';

describe('OrdersService', () => {
  let service: OrdersService;
  let redis: { defineCommand: jest.Mock; claimStock: jest.Mock };
  let queue: { add: jest.Mock };

  beforeEach(async () => {
    // ioredis custom command: constructor calls defineCommand, then claim() calls
    // the generated redis.claimStock(...).
    redis = { defineCommand: jest.fn(), claimStock: jest.fn() };
    queue = { add: jest.fn().mockResolvedValue({ id: 'job-1' }) };

    const module = await Test.createTestingModule({
      providers: [
        OrdersService,
        { provide: REDIS_CLIENT, useValue: redis },
        { provide: getQueueToken('orders'), useValue: queue },
      ],
    }).compile();

    service = module.get(OrdersService);
  });

  it('enqueues a deterministic job and returns 202-shaped payload on success', async () => {
    redis.claimStock.mockResolvedValue(49);

    const result = await service.claim('user-1', 'p-1001');

    expect(queue.add).toHaveBeenCalledWith(
      'deduct',
      { userId: 'user-1', productId: 'p-1001' },
      expect.objectContaining({ jobId: 'user-1|p-1001', attempts: 3 }),
    );
    expect(result).toEqual({
      status: 'processing',
      orderJobId: 'job-1',
      message: 'Your order is in the queue.',
    });
  });

  it('rejects a duplicate claim without touching the queue', async () => {
    redis.claimStock.mockResolvedValue(-1);

    await expect(service.claim('user-1', 'p-1001')).rejects.toBeInstanceOf(ConflictException);
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('rejects a sold-out claim without touching the queue', async () => {
    redis.claimStock.mockResolvedValue(-2);

    await expect(service.claim('user-1', 'p-1001')).rejects.toBeInstanceOf(ConflictException);
    expect(queue.add).not.toHaveBeenCalled();
  });
});
