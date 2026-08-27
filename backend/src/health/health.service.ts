import { Inject, Injectable } from '@nestjs/common';
import Redis from 'ioredis';
import { DataSource } from 'typeorm';
import { REDIS_CLIENT } from '../redis/redis.provider';

@Injectable()
export class HealthService {
    constructor(
    private readonly dataSource: DataSource,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    ) {}

    // Liveness Probe: เช็คแค่ Process ทำงานปกติ
    getLiveness() {
    return {
        status: 'ok',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
    };
    }

    // Readiness Probe: เช็ค DB + Redis + Dependencies
    async getReadiness() {
    const checks = await Promise.allSettled([
        this.checkDatabase(),
        this.checkRedis(),
    ]);

    const dbResult = checks[0].status === 'fulfilled' ? checks[0].value : { status: 'down', error: checks[0].reason?.message };
    const redisResult = checks[1].status === 'fulfilled' ? checks[1].value : { status: 'down', error: checks[1].reason?.message };

    const isReady = dbResult.status === 'up' && redisResult.status === 'up';

    return {
        status: isReady ? 'ok' : 'error',
        timestamp: new Date().toISOString(),
        details: {
        database: dbResult,
        redis: redisResult,
        },
    };
    }

    private async checkDatabase() {
    // รัน Lightweight query เช่น SELECT 1
    await this.dataSource.query('SELECT 1');
    return { status: 'up' };
    }

    private async checkRedis() {
    const pong = await this.redis.ping();
    if (pong !== 'PONG') throw new Error('Redis ping failed');
    return { status: 'up' };
    }
}
