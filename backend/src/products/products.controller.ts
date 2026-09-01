import { Controller, Get, Query, Res } from '@nestjs/common';
import { FastifyReply } from 'fastify';
import { ProductsService } from './products.service';

@Controller('api/v1/products')
export class ProductsController {
  constructor(private readonly productsService: ProductsService) {}

  @Get()
  async list(
    @Res() reply: FastifyReply,
    @Query('page') pageRaw?: string,
    @Query('limit') limitRaw?: string,
  ): Promise<void> {
    // Plain query parsing — the spec passes page/limit as bare query params, not
    // a DTO. Clamp to sane bounds so a bad value can't skip/take the whole table.
    const page = Math.max(1, parseInt(pageRaw ?? '', 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(limitRaw ?? '', 10) || 10));

    // Service returns the finished JSON body as a string; send it as-is so
    // Fastify does not re-serialise it and Nest does not parse it.
    const body = await this.productsService.getPageRaw(page, limit);
    reply.header('content-type', 'application/json; charset=utf-8').send(body);
  }
}
