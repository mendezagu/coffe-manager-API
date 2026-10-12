-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('PENDING', 'PREPARING', 'READY');

-- AlterTable: las órdenes que ya existen se consideran entregadas (READY) para que no
-- aparezcan como pendientes en cocina; las nuevas arrancan en PENDING.
ALTER TABLE "orders"
  ADD COLUMN "status" "OrderStatus" NOT NULL DEFAULT 'READY',
  ADD COLUMN "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "orders" ALTER COLUMN "status" SET DEFAULT 'PENDING';
