-- Comisión para mozos: opción del negocio y porcentaje que quedó vigente en cada venta (las anteriores quedan en 0).
ALTER TABLE "tenants" ADD COLUMN "commissionEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "tenants" ADD COLUMN "commissionPct" DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE "sales" ADD COLUMN "commissionPct" DOUBLE PRECISION NOT NULL DEFAULT 0;
