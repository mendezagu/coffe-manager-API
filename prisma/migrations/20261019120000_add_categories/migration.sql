-- Rol de barra (usuario que ve solo lo que va a la barra)
ALTER TYPE "Role" ADD VALUE 'BAR';

-- CreateEnum
CREATE TYPE "Destination" AS ENUM ('KITCHEN', 'BAR');

-- CreateTable
CREATE TABLE "categories" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "destination" "Destination" NOT NULL DEFAULT 'KITCHEN',

    CONSTRAINT "categories_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "categories_tenantId_name_key" ON "categories"("tenantId", "name");

ALTER TABLE "categories" ADD CONSTRAINT "categories_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Plato -> categoría (opcional; si se borra la categoría el plato queda sin categoría)
ALTER TABLE "menu_items" ADD COLUMN "categoryId" TEXT;

CREATE INDEX "menu_items_categoryId_idx" ON "menu_items"("categoryId");

ALTER TABLE "menu_items" ADD CONSTRAINT "menu_items_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Plan y opción de separar cocina y barra. Los negocios existentes quedan en el plan "pro"
-- (con la función disponible) pero con la separación apagada: todo sigue yendo a cocina.
ALTER TABLE "tenants"
  ADD COLUMN "plan" TEXT NOT NULL DEFAULT 'pro',
  ADD COLUMN "splitKitchenBar" BOOLEAN NOT NULL DEFAULT false;
