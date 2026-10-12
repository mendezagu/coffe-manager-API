-- CreateTable
CREATE TABLE "sales" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "checkoutId" TEXT NOT NULL,
    "tableName" TEXT NOT NULL,
    "waiterName" TEXT NOT NULL,
    "cashierName" TEXT NOT NULL DEFAULT '',
    "paymentMethod" TEXT NOT NULL,
    "grossTotal" DOUBLE PRECISION NOT NULL,
    "discountTotal" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "globalDiscountPct" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "totalAmount" DOUBLE PRECISION NOT NULL,
    "date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sales_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sale_items" (
    "id" TEXT NOT NULL,
    "saleId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "unitPrice" DOUBLE PRECISION NOT NULL,
    "quantity" INTEGER NOT NULL,
    "note" TEXT NOT NULL DEFAULT '',
    "isPromo" BOOLEAN NOT NULL DEFAULT false,
    "discountPct" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "lineTotal" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "sale_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "sales_tenantId_checkoutId_key" ON "sales"("tenantId", "checkoutId");
CREATE INDEX "sales_tenantId_date_idx" ON "sales"("tenantId", "date");
CREATE INDEX "sale_items_saleId_idx" ON "sale_items"("saleId");

-- AddForeignKey
ALTER TABLE "sales" ADD CONSTRAINT "sales_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "sale_items" ADD CONSTRAINT "sale_items_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "sales"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Los balances del sistema anterior pasan a ser ventas sin detalle (solo existía el total).
INSERT INTO "sales" ("id", "tenantId", "checkoutId", "tableName", "waiterName", "paymentMethod", "grossTotal", "totalAmount", "date")
SELECT "id", "tenantId", "orderId", "tableName", "waiterName", "paymentMethod", "totalAmount", "totalAmount", "date"
FROM "balances";

-- DropTable
DROP TABLE "balances";
