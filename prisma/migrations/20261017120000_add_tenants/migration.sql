-- CreateTable
CREATE TABLE "tenants" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "legalName" TEXT NOT NULL DEFAULT '',
    "taxIdLabel" TEXT NOT NULL DEFAULT 'CUIT',
    "taxId" TEXT NOT NULL DEFAULT '',
    "address" TEXT NOT NULL DEFAULT '',
    "city" TEXT NOT NULL DEFAULT '',
    "postalCode" TEXT NOT NULL DEFAULT '',
    "phone" TEXT NOT NULL DEFAULT '',
    "ticketFooter" TEXT NOT NULL DEFAULT '',
    "logoUrl" TEXT,
    "currencyCode" TEXT NOT NULL DEFAULT 'ARS',
    "locale" TEXT NOT NULL DEFAULT 'es-AR',
    "shiftMorningStart" INTEGER NOT NULL DEFAULT 6,
    "shiftAfternoonStart" INTEGER NOT NULL DEFAULT 12,
    "shiftNightStart" INTEGER NOT NULL DEFAULT 18,

    CONSTRAINT "tenants_pkey" PRIMARY KEY ("id")
);

-- Negocio inicial: todo lo que ya existe en la base pasa a pertenecerle.
INSERT INTO "tenants" ("id", "name") VALUES ('00000000-0000-0000-0000-000000000001', 'Mi restaurante');

-- Si la base ya tenía datos, son los de Nuovo Caffe (lo que antes estaba escrito en el código).
-- Una base nueva queda con el negocio en blanco para configurarlo desde la app.
UPDATE "tenants" SET
    "name" = 'Nuovo Caffe',
    "legalName" = 'De Aylen Leonela Lupino',
    "taxId" = '27-37630138-4',
    "address" = 'Libertad 321',
    "city" = 'Sta Rosa de Calamuchita',
    "postalCode" = '5196',
    "ticketFooter" = E'Documento no válido como factura\nPida su factura en caja',
    "logoUrl" = 'assets/nuovo-cafe.jpg'
WHERE "id" = '00000000-0000-0000-0000-000000000001'
  AND (EXISTS (SELECT 1 FROM "tables") OR EXISTS (SELECT 1 FROM "menu_items") OR EXISTS (SELECT 1 FROM "users"));

-- tenantId en waiters, sectors, menu_items, tables, balances y users: se llena con el
-- negocio inicial y recién después pasa a ser obligatorio.
ALTER TABLE "waiters" ADD COLUMN "tenantId" TEXT;
ALTER TABLE "sectors" ADD COLUMN "tenantId" TEXT;
ALTER TABLE "menu_items" ADD COLUMN "tenantId" TEXT;
ALTER TABLE "tables" ADD COLUMN "tenantId" TEXT;
ALTER TABLE "balances" ADD COLUMN "tenantId" TEXT;
ALTER TABLE "users" ADD COLUMN "tenantId" TEXT;

UPDATE "waiters" SET "tenantId" = '00000000-0000-0000-0000-000000000001';
UPDATE "sectors" SET "tenantId" = '00000000-0000-0000-0000-000000000001';
UPDATE "menu_items" SET "tenantId" = '00000000-0000-0000-0000-000000000001';
UPDATE "tables" SET "tenantId" = '00000000-0000-0000-0000-000000000001';
UPDATE "balances" SET "tenantId" = '00000000-0000-0000-0000-000000000001';
UPDATE "users" SET "tenantId" = '00000000-0000-0000-0000-000000000001';

ALTER TABLE "waiters" ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "sectors" ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "menu_items" ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "tables" ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "balances" ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "users" ALTER COLUMN "tenantId" SET NOT NULL;

-- Unicidad por negocio (antes era global)
DROP INDEX "sectors_name_key";
DROP INDEX "balances_orderId_key";
CREATE UNIQUE INDEX "sectors_tenantId_name_key" ON "sectors"("tenantId", "name");
CREATE UNIQUE INDEX "balances_tenantId_orderId_key" ON "balances"("tenantId", "orderId");

-- Índices
CREATE INDEX "waiters_tenantId_idx" ON "waiters"("tenantId");
CREATE INDEX "menu_items_tenantId_idx" ON "menu_items"("tenantId");
CREATE INDEX "tables_tenantId_idx" ON "tables"("tenantId");
CREATE INDEX "users_tenantId_idx" ON "users"("tenantId");

-- Claves foráneas
ALTER TABLE "waiters" ADD CONSTRAINT "waiters_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "sectors" ADD CONSTRAINT "sectors_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "menu_items" ADD CONSTRAINT "menu_items_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "tables" ADD CONSTRAINT "tables_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "balances" ADD CONSTRAINT "balances_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "users" ADD CONSTRAINT "users_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
