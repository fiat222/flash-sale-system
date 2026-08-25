import { Controller, Get, Query, Res } from '@nestjs/common';
import { FastifyReply } from 'fastify';
import { ProductsService } from './products.service';

@Controller('api/v1/products')
export class ProductsController {
  constructor(private readonly productsService: ProductsService) {}

  @Get()
  async list(
    @Query('page') pageRaw: string,
    @Query('limit') limitRaw: string,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    // Manual parsing instead of a class-validator DTO — this is the hottest
    // path in the system, reflection-based validation isn't worth it here.
    const page = Math.max(1, parseInt(pageRaw, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(limitRaw, 10) || 10));

    const body = await this.productsService.getPage(page, limit);
    reply.header('content-type', 'application/json').send(body);
  }
}
