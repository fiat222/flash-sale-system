import { Controller, Get, Query } from '@nestjs/common';
import { ProductsService, ProductPage } from './products.service';

@Controller('api/v1/products')
export class ProductsController {
  constructor(private readonly productsService: ProductsService) {}

  @Get()
  list(
    @Query('page') pageRaw?: string,
    @Query('limit') limitRaw?: string,
  ): Promise<ProductPage> {
    // Plain query parsing — the spec passes page/limit as bare query params, not
    // a DTO. Clamp to sane bounds so a bad value can't skip/take the whole table.
    const page = Math.max(1, parseInt(pageRaw ?? '', 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(limitRaw ?? '', 10) || 10));
    return this.productsService.getPage(page, limit);
  }
}
