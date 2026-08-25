import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { Product } from './entities/product.entity';
import { Order } from './entities/order.entity';

const poolSize =
  process.env.ROLE === 'worker'
    ? Number(process.env.POSTGRES_POOL_WORKER ?? 10)
    : Number(process.env.POSTGRES_POOL_API ?? 5);

export const AppDataSource = new DataSource({
  type: 'postgres',
  host: process.env.POSTGRES_HOST ?? 'localhost',
  port: Number(process.env.POSTGRES_PORT ?? 5432),
  database: process.env.POSTGRES_DB ?? 'flash_sale',
  username: process.env.POSTGRES_USER ?? 'flash_sale',
  password: process.env.POSTGRES_PASSWORD ?? 'changeme',
  entities: [Product, Order],
  migrations: [__dirname + '/migrations/*.{ts,js}'],
  poolSize,
  synchronize: false,
});
