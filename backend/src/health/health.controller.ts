import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import { FastifyReply } from 'fastify';
import { HealthService } from './health.service';

@Controller('health')
export class HealthController {
    constructor(private readonly healthService: HealthService) {}

    // GET /health/live
    @Get('live')
    checkLiveness() {
    return this.healthService.getLiveness();
    }

    // GET /health/readiness
    @Get('ready')
    async checkReadiness(@Res({ passthrough: true }) res: FastifyReply) {
    const result = await this.healthService.getReadiness();
    if (result.status !== 'ok') {
        res.status(HttpStatus.SERVICE_UNAVAILABLE); // HTTP 503
    }
    return result;
    }
}