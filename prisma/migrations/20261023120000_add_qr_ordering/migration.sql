-- CreateEnum
CREATE TYPE "QrRequestStatus" AS ENUM ('PENDING', 'CONFIRMED', 'REJECTED', 'CANCELLED');
CREATE TYPE "ServiceCallType" AS ENUM ('WAITER', 'BILL');
CREATE TYPE "ServiceCallStatus" AS ENUM ('OPEN', 'DONE');

-- Mesas: código del QR (se completa al generar los QR) y código de mesa
ALTER TABLE "tables" ADD COLUMN "qrToken" TEXT, ADD COLUMN "qrPin" TEXT NOT NULL DEFAULT '';
CREATE UNIQUE INDEX "tables_qrToken_key" ON "tables"("qrToken");

-- Negocio: opciones del pedido por QR
ALTER TABLE "tenants"
  ADD COLUMN "qrEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "qrAutoConfirm" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "qrRequirePin" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "qr_order_requests" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "tableId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "customerName" TEXT NOT NULL DEFAULT '',
    "items" JSONB NOT NULL,
    "total" DOUBLE PRECISION NOT NULL,
    "status" "QrRequestStatus" NOT NULL DEFAULT 'PENDING',
    "rejectReason" TEXT NOT NULL DEFAULT '',
    "orderIds" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "resolvedBy" TEXT,

    CONSTRAINT "qr_order_requests_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "service_calls" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "tableId" TEXT NOT NULL,
    "type" "ServiceCallType" NOT NULL,
    "status" "ServiceCallStatus" NOT NULL DEFAULT 'OPEN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "resolvedBy" TEXT,

    CONSTRAINT "service_calls_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "qr_order_requests_tenantId_status_idx" ON "qr_order_requests"("tenantId", "status");
CREATE INDEX "qr_order_requests_tableId_createdAt_idx" ON "qr_order_requests"("tableId", "createdAt");
CREATE INDEX "service_calls_tenantId_status_idx" ON "service_calls"("tenantId", "status");
CREATE INDEX "service_calls_tableId_status_idx" ON "service_calls"("tableId", "status");

-- AddForeignKey
ALTER TABLE "qr_order_requests" ADD CONSTRAINT "qr_order_requests_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "qr_order_requests" ADD CONSTRAINT "qr_order_requests_tableId_fkey" FOREIGN KEY ("tableId") REFERENCES "tables"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "service_calls" ADD CONSTRAINT "service_calls_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "service_calls" ADD CONSTRAINT "service_calls_tableId_fkey" FOREIGN KEY ("tableId") REFERENCES "tables"("id") ON DELETE CASCADE ON UPDATE CASCADE;
