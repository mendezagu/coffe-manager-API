-- CreateEnum
CREATE TYPE "StockMovementType" AS ENUM ('PURCHASE', 'SALE', 'WASTE', 'ADJUSTMENT');

-- CreateTable
CREATE TABLE "stock_items" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "unit" TEXT NOT NULL DEFAULT 'unidad',
    "onHand" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "minStock" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "costPerUnit" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_items_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "stock_movements" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "stockItemId" TEXT NOT NULL,
    "type" "StockMovementType" NOT NULL,
    "quantity" DOUBLE PRECISION NOT NULL,
    "balanceAfter" DOUBLE PRECISION NOT NULL,
    "unitCost" DOUBLE PRECISION,
    "supplier" TEXT NOT NULL DEFAULT '',
    "note" TEXT NOT NULL DEFAULT '',
    "reference" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_movements_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "menu_item_ingredients" (
    "menuItemId" TEXT NOT NULL,
    "stockItemId" TEXT NOT NULL,
    "quantity" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "menu_item_ingredients_pkey" PRIMARY KEY ("menuItemId", "stockItemId")
);

CREATE TABLE "modifier_option_ingredients" (
    "id" TEXT NOT NULL,
    "optionId" TEXT NOT NULL,
    "stockItemId" TEXT NOT NULL,
    "quantity" DOUBLE PRECISION NOT NULL,
    "replacesStockItemId" TEXT,

    CONSTRAINT "modifier_option_ingredients_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "stock_items_tenantId_name_key" ON "stock_items"("tenantId", "name");
CREATE INDEX "stock_movements_tenantId_createdAt_idx" ON "stock_movements"("tenantId", "createdAt");
CREATE INDEX "stock_movements_stockItemId_createdAt_idx" ON "stock_movements"("stockItemId", "createdAt");
CREATE INDEX "menu_item_ingredients_stockItemId_idx" ON "menu_item_ingredients"("stockItemId");
CREATE UNIQUE INDEX "modifier_option_ingredients_optionId_stockItemId_key" ON "modifier_option_ingredients"("optionId", "stockItemId");
CREATE INDEX "modifier_option_ingredients_stockItemId_idx" ON "modifier_option_ingredients"("stockItemId");

-- AddForeignKey
ALTER TABLE "stock_items" ADD CONSTRAINT "stock_items_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_stockItemId_fkey" FOREIGN KEY ("stockItemId") REFERENCES "stock_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "menu_item_ingredients" ADD CONSTRAINT "menu_item_ingredients_menuItemId_fkey" FOREIGN KEY ("menuItemId") REFERENCES "menu_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "menu_item_ingredients" ADD CONSTRAINT "menu_item_ingredients_stockItemId_fkey" FOREIGN KEY ("stockItemId") REFERENCES "stock_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "modifier_option_ingredients" ADD CONSTRAINT "modifier_option_ingredients_optionId_fkey" FOREIGN KEY ("optionId") REFERENCES "modifier_options"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "modifier_option_ingredients" ADD CONSTRAINT "modifier_option_ingredients_stockItemId_fkey" FOREIGN KEY ("stockItemId") REFERENCES "stock_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Costo de cada línea vendida (null en las ventas anteriores: no se conocía)
ALTER TABLE "sale_items" ADD COLUMN "unitCost" DOUBLE PRECISION;

-- Opciones de inventario del negocio
ALTER TABLE "tenants"
  ADD COLUMN "inventoryEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "blockOutOfStock" BOOLEAN NOT NULL DEFAULT true;
