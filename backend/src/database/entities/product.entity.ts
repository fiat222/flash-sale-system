import { Check, Column, Entity, PrimaryColumn } from 'typeorm';

@Entity('products')
@Check('chk_remaining_stock_non_negative', '"remaining_stock" >= 0')
export class Product {
  @PrimaryColumn({ name: 'product_id', type: 'varchar', length: 20 })
  productId: string;

  @Column({ type: 'varchar', length: 200 })
  name: string;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  @Column({ type: 'numeric', precision: 10, scale: 2 })
  price: string;

  @Column({ name: 'available_stock', type: 'int' })
  availableStock: number;

  @Column({ name: 'remaining_stock', type: 'int' })
  remainingStock: number;

  @Column({ name: 'is_flash_sale_active', type: 'boolean', default: false })
  isFlashSaleActive: boolean;
}
