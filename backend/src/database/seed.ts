import { readFileSync } from 'fs';
import { join } from 'path';
import Redis from 'ioredis';
import { AppDataSource } from './data-source';
import { Product } from './entities/product.entity';

interface SeedProduct {
  productId: string;
  name: string;
  description: string;
  price: number;
  availableStock: number;
  isFlashSaleActive: boolean;
}

export async function seed(): Promise<void> {
  const raw = readFileSync(join(__dirname, '../../data/products-seed.json'), 'utf-8');
  const products: SeedProduct[] = JSON.parse(raw);

  const repo = AppDataSource.getRepository(Product);
  for (const p of products) {
    await repo.upsert(
      {
        productId: p.productId,
        name: p.name,
        description: p.description,
        price: p.price.toFixed(2),
        availableStock: p.availableStock,
        remainingStock: p.availableStock,
        isFlashSaleActive: p.isFlashSaleActive,
      },
      ['productId'],
    );
  }

  const redis = new Redis({
    host: process.env.REDIS_HOST ?? 'localhost',
    port: Number(process.env.REDIS_PORT ?? 6379),
  });

  // SET NX — if the API/worker already touched cache:stock:* (e.g. this seed
  // reran after a partial run), don't clobber real-time state back to full stock.
  for (const p of products) {
    await redis.set(`cache:stock:${p.productId}`, p.availableStock, 'EX', 86400, 'NX');
  }

  await redis.quit();
}

if (require.main === module) {
  AppDataSource.initialize()
    .then(() => seed())
    .then(() => AppDataSource.destroy())
    .then(() => {
      // eslint-disable-next-line no-console
      console.log('Seed complete.');
      process.exit(0);
    })
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error('Seed failed:', err);
      process.exit(1);
    });
}
