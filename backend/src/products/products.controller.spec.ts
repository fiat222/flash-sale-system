import { FastifyReply } from 'fastify';
import { ProductsController } from './products.controller';
import { ProductsService } from './products.service';

describe('ProductsController', () => {
  let controller: ProductsController;
  let productsService: { getPage: jest.Mock };
  let reply: { header: jest.Mock; send: jest.Mock; statusCode: number };

  beforeEach(() => {
    productsService = { getPage: jest.fn().mockResolvedValue('{"status":"success","data":[]}') };
    reply = {
      header: jest.fn().mockReturnThis(),
      send: jest.fn().mockReturnThis(),
      statusCode: 200,
    };
    controller = new ProductsController(productsService as unknown as ProductsService);
  });

  async function list(page?: string, limit?: string): Promise<void> {
    await controller.list(page as string, limit as string, reply as unknown as FastifyReply);
  }

  it('uses default pagination and sends the JSON string directly through Fastify', async () => {
    await list();

    expect(productsService.getPage).toHaveBeenCalledTimes(1);
    expect(productsService.getPage).toHaveBeenCalledWith(1, 10);
    expect(reply.header).toHaveBeenCalledWith('content-type', 'application/json');
    expect(reply.send).toHaveBeenCalledWith('{"status":"success","data":[]}');
  });

  it('passes valid pagination through unchanged', async () => {
    await list('2', '5');

    expect(productsService.getPage).toHaveBeenCalledWith(2, 5);
  });

  it.each([
    ['non-numeric values', 'abc', 'not-a-number'],
    ['a zero limit', '2', '0'],
  ])('falls back to defaults for %s', async (_case, page, limit) => {
    await list(page, limit);

    expect(productsService.getPage).toHaveBeenCalledWith(page === '2' ? 2 : 1, 10);
  });

  it('clamps negative parsed values to the lower bound', async () => {
    await list('-5', '-8');

    expect(productsService.getPage).toHaveBeenCalledWith(1, 1);
  });

  it('clamps an oversized limit to 100', async () => {
    await list('3', '999');

    expect(productsService.getPage).toHaveBeenCalledWith(3, 100);
  });

  it('forwards an empty-page response without changing the successful response contract', async () => {
    const body = '{"status":"success","data":[],"meta":{"total":20,"page":99999,"limit":10,"totalPages":2}}';
    productsService.getPage.mockResolvedValue(body);

    await list('99999', '10');

    expect(productsService.getPage).toHaveBeenCalledWith(99999, 10);
    expect(reply.statusCode).toBe(200);
    expect(reply.send).toHaveBeenCalledWith(body);
  });
});
