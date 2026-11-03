-- Tienda online (/delivery/<slug>): ajustes del local y pedidos
ALTER TABLE "tenants"
  ADD COLUMN "deliveryEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "deliveryPaused" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "deliveryPickup" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "deliveryHome" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "deliveryFee" DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN "deliveryDest" TEXT NOT NULL DEFAULT 'system',
  ADD COLUMN "deliveryWhatsapp" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "deliveryPayCash" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "deliveryPayTransfer" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "deliveryBankInfo" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "deliveryPrepMin" INTEGER NOT NULL DEFAULT 30;

CREATE TYPE "DeliveryStatus" AS ENUM ('PENDING', 'ACCEPTED', 'READY', 'COMPLETED', 'REJECTED', 'CANCELLED');

CREATE TABLE "delivery_orders" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "trackToken" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "customerName" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "address" TEXT NOT NULL DEFAULT '',
    "payMethod" TEXT NOT NULL,
    "note" TEXT NOT NULL DEFAULT '',
    "items" JSONB NOT NULL,
    "subtotal" DOUBLE PRECISION NOT NULL,
    "deliveryFee" DOUBLE PRECISION NOT NULL,
    "total" DOUBLE PRECISION NOT NULL,
    "status" "DeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "rejectReason" TEXT NOT NULL DEFAULT '',
    "saleId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "resolvedBy" TEXT,

    CONSTRAINT "delivery_orders_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "delivery_orders_trackToken_key" ON "delivery_orders"("trackToken");
CREATE UNIQUE INDEX "delivery_orders_tenantId_number_key" ON "delivery_orders"("tenantId", "number");
CREATE INDEX "delivery_orders_tenantId_status_idx" ON "delivery_orders"("tenantId", "status");

ALTER TABLE "delivery_orders" ADD CONSTRAINT "delivery_orders_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
