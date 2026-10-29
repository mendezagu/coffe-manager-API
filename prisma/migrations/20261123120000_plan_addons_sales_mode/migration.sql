-- Extras por negocio (funciones sueltas sumadas al plan) y modo de venta (mostrador / mesas / ambos)
ALTER TABLE "tenants" ADD COLUMN "addons" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "tenants" ADD COLUMN "salesMode" TEXT NOT NULL DEFAULT 'both';
