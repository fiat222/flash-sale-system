import { MigrationInterface, QueryRunner } from 'typeorm';

export class InitSchema1700000000000 implements MigrationInterface {
  name = 'InitSchema1700000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "products" (
        "product_id" VARCHAR(20) PRIMARY KEY,
        "name" VARCHAR(200) NOT NULL,
        "description" TEXT,
        "price" NUMERIC(10,2) NOT NULL,
        "available_stock" INT NOT NULL,
        "remaining_stock" INT NOT NULL,
        "is_flash_sale_active" BOOLEAN NOT NULL DEFAULT false,
        CONSTRAINT "chk_remaining_stock_non_negative" CHECK ("remaining_stock" >= 0)
      );
    `);

    await queryRunner.query(`
      CREATE TABLE "orders" (
        "id" BIGSERIAL PRIMARY KEY,
        "user_id" VARCHAR(50) NOT NULL,
        "product_id" VARCHAR(20) NOT NULL REFERENCES "products"("product_id"),
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "uq_user_product" UNIQUE ("user_id", "product_id")
      );
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "orders";`);
    await queryRunner.query(`DROP TABLE "products";`);
  }
}
