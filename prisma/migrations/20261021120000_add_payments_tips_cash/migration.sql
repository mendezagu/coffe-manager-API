-- ===== Pagos (mixtos y vuelto) =====
CREATE TABLE "payments" (
    "id" TEXT NOT NULL,
    "saleId" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "tendered" DOUBLE PRECISION,
    "change" DOUBLE PRECISION NOT NULL DEFAULT 0,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "payments_saleId_idx" ON "payments"("saleId");

ALTER TABLE "payments" ADD CONSTRAINT "payments_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "sales"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Las ventas existentes tenían un solo método por el total: pasan a tener un pago por ese importe.
INSERT INTO "payments" ("id", "saleId", "method", "amount")
SELECT gen_random_uuid()::text, "id", "paymentMethod", "totalAmount" FROM "sales";

-- ===== Propinas =====
ALTER TABLE "sales" ADD COLUMN "tipAmount" DOUBLE PRECISION NOT NULL DEFAULT 0;

ALTER TABLE "tenants"
  ADD COLUMN "tipEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "tipSuggestedPct" INTEGER NOT NULL DEFAULT 10;

-- ===== Caja =====
CREATE TYPE "CashMovementType" AS ENUM ('IN', 'OUT');

CREATE TABLE "cash_registers" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "openedByName" TEXT NOT NULL,
    "openingAmount" DOUBLE PRECISION NOT NULL,
    "closedAt" TIMESTAMP(3),
    "closedByName" TEXT,
    "expectedAmount" DOUBLE PRECISION,
    "countedAmount" DOUBLE PRECISION,
    "difference" DOUBLE PRECISION,
    "note" TEXT NOT NULL DEFAULT '',

    CONSTRAINT "cash_registers_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "cash_movements" (
    "id" TEXT NOT NULL,
    "registerId" TEXT NOT NULL,
    "type" "CashMovementType" NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "reason" TEXT NOT NULL,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cash_movements_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "cash_registers_tenantId_openedAt_idx" ON "cash_registers"("tenantId", "openedAt");
CREATE INDEX "cash_movements_registerId_idx" ON "cash_movements"("registerId");

ALTER TABLE "cash_registers" ADD CONSTRAINT "cash_registers_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "cash_movements" ADD CONSTRAINT "cash_movements_registerId_fkey" FOREIGN KEY ("registerId") REFERENCES "cash_registers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Ventas -> caja (las anteriores quedan sin caja)
ALTER TABLE "sales" ADD COLUMN "registerId" TEXT;
CREATE INDEX "sales_registerId_idx" ON "sales"("registerId");
ALTER TABLE "sales" ADD CONSTRAINT "sales_registerId_fkey" FOREIGN KEY ("registerId") REFERENCES "cash_registers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Negocio: exigir caja abierta para cobrar, y cuál es la abierta ahora
ALTER TABLE "tenants"
  ADD COLUMN "requireOpenRegister" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "openRegisterId" TEXT;

CREATE UNIQUE INDEX "tenants_openRegisterId_key" ON "tenants"("openRegisterId");
